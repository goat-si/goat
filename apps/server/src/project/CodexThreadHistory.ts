// @effect-diagnostics nodeBuiltinImport:off - Codex keeps pruned conversation history in SQLite; this is a small read-only lookup.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import type { AgentSessionImportSource, ProviderInstanceId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { AgentSessionThread } from "./AgentSessionScanner.ts";

const MAX_CODEX_HISTORY_MESSAGES = 200;
const MAX_CODEX_HISTORY_BYTES = 32 * 1024 * 1024;
const MAX_CODEX_HISTORY_THREAD_IDS = 100_000;
const MAX_DATE_MS = 8.64e15;
const HISTORY_DATABASE = /^thread_history_(\d+)\.sqlite$/;

const UserMessage = Schema.Struct({
  type: Schema.Literal("userMessage"),
  content: Schema.Array(
    Schema.Struct({ type: Schema.optional(Schema.String), text: Schema.optional(Schema.String) }),
  ),
});
const AgentMessage = Schema.Struct({
  type: Schema.Literal("agentMessage"),
  text: Schema.String,
});
const decodeUserMessage = Schema.decodeUnknownOption(Schema.fromJsonString(UserMessage));
const decodeAgentMessage = Schema.decodeUnknownOption(Schema.fromJsonString(AgentMessage));
const UNSUPPORTED_MESSAGE = new Error("Codex history holds a message shape GOAT cannot read");

export interface CodexHistoryMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAtMs: number;
}

export interface CodexHistoryThreadData {
  readonly messages: ReadonlyArray<CodexHistoryMessage>;
  readonly omittedMessageCount: number;
  readonly createdAtMs: number;
  readonly bytes: number;
}

export interface CodexHistoryThreadRef {
  readonly id: string;
  readonly title: string;
  readonly model: string | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly homePath: string;
}

type HistoryDatabaseLocation =
  | { readonly _tag: "Found"; readonly path: string }
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Failed"; readonly cause: unknown };

function historyDatabasePath(homePath: string): HistoryDatabaseLocation {
  try {
    const names = NodeFS.readdirSync(homePath);
    const versioned = names
      .map((name) => [name, Number(HISTORY_DATABASE.exec(name)?.[1] ?? 0)] as const)
      .filter(([name, version]) => HISTORY_DATABASE.test(name) && version > 0)
      .sort((left, right) => right[1] - left[1])[0]?.[0];
    if (versioned !== undefined) return { _tag: "Found", path: NodePath.join(homePath, versioned) };
    const legacy = NodePath.join(homePath, "thread_history.sqlite");
    return NodeFS.existsSync(legacy) ? { _tag: "Found", path: legacy } : { _tag: "Missing" };
  } catch (cause) {
    return (cause as { readonly code?: unknown }).code === "ENOENT"
      ? { _tag: "Missing" }
      : { _tag: "Failed", cause };
  }
}

export interface CodexHistoryThreadIds {
  readonly ids: ReadonlySet<string>;
  readonly complete: boolean;
  readonly error?: unknown;
}

export function readCodexHistoryThreadIds(homePath: string): CodexHistoryThreadIds {
  const empty = { ids: new Set<string>(), complete: true } as const;
  const location = historyDatabasePath(homePath);
  if (location._tag === "Failed") return { ids: new Set(), complete: false, error: location.cause };
  if (location._tag === "Missing") return empty;
  let database: NodeSqlite.DatabaseSync;
  try {
    database = new NodeSqlite.DatabaseSync(location.path, { readOnly: true, timeout: 1000 });
  } catch (error) {
    return { ids: new Set(), complete: false, error };
  }
  try {
    // Presence check only: oversized or text-less threads drop out at import, so this count is an upper bound.
    const rows = database
      .prepare(
        "SELECT DISTINCT thread_id FROM thread_items WHERE item_type = 'userMessage' LIMIT ?",
      )
      .all(MAX_CODEX_HISTORY_THREAD_IDS + 1) as unknown as ReadonlyArray<{
      thread_id?: unknown;
    }>;
    if (rows.length > MAX_CODEX_HISTORY_THREAD_IDS) {
      return { ids: new Set(), complete: false, error: "too-many-history-threads" };
    }
    return {
      ids: new Set(
        rows.flatMap((row) => (typeof row.thread_id === "string" ? [row.thread_id] : [])),
      ),
      complete: true,
    };
  } catch (error) {
    return { ids: new Set(), complete: false, error };
  } finally {
    database.close();
  }
}

function toMs(value: unknown, fallback: number): number {
  const ms = typeof value === "number" ? value : Number(value);
  return Number.isFinite(ms) && Math.abs(ms) <= MAX_DATE_MS ? ms : fallback;
}

/** Text of a message, "" for one without text, or undefined for a shape this reader does not know. */
function messageText(itemType: unknown, itemJson: unknown): string | undefined {
  if (typeof itemJson !== "string") return undefined;
  if (itemType === "userMessage") {
    const decoded = decodeUserMessage(itemJson);
    if (Option.isNone(decoded)) return undefined;
    return decoded.value.content
      .filter(
        (block) =>
          block.type === undefined ||
          block.type === "text" ||
          block.type === "input_text" ||
          block.type === "output_text",
      )
      .map((block) => block.text?.trim() ?? "")
      .filter((text) => text.length > 0)
      .join("\n");
  }
  if (itemType === "agentMessage") {
    const decoded = decodeAgentMessage(itemJson);
    return Option.isSome(decoded) ? decoded.value.text.trim() : undefined;
  }
  return undefined;
}

interface HistoryRow {
  readonly item_type: unknown;
  readonly item_json: unknown;
  readonly created_at_ms: unknown;
  readonly rollout_ordinal: unknown;
  readonly bytes?: unknown;
}

export type CodexHistoryReadResult =
  | { readonly _tag: "Ok"; readonly data: CodexHistoryThreadData }
  | { readonly _tag: "Empty" }
  | { readonly _tag: "TooLarge" }
  | { readonly _tag: "Failed"; readonly cause: unknown };

export interface CodexThreadHistoryReader {
  readonly read: (threadId: string) => CodexHistoryReadResult;
  readonly close: () => void;
}

export function openCodexThreadHistory(
  homePath: string,
  maxBytes = MAX_CODEX_HISTORY_BYTES,
): CodexThreadHistoryReader | null {
  const location = historyDatabasePath(homePath);
  if (location._tag !== "Found") return null;
  let database: NodeSqlite.DatabaseSync;
  try {
    database = new NodeSqlite.DatabaseSync(location.path, { readOnly: true, timeout: 1000 });
  } catch {
    return null;
  }
  try {
    const count = database.prepare(
      "SELECT COUNT(*) AS count FROM thread_items WHERE thread_id = ? AND item_type IN ('userMessage', 'agentMessage')",
    );
    const recentBytes = database.prepare(
      "SELECT COALESCE(SUM(LENGTH(CAST(item_json AS BLOB))), 0) AS bytes FROM (SELECT item_json FROM thread_items WHERE thread_id = ? AND item_type IN ('userMessage', 'agentMessage') ORDER BY rollout_ordinal DESC LIMIT ?)",
    );
    const recent = database.prepare(
      "SELECT item_type, item_json, created_at_ms, rollout_ordinal FROM thread_items WHERE thread_id = ? AND item_type IN ('userMessage', 'agentMessage') ORDER BY rollout_ordinal DESC LIMIT ?",
    );
    const firstUser = database.prepare(
      "SELECT item_type, item_json, created_at_ms, rollout_ordinal, LENGTH(CAST(item_json AS BLOB)) AS bytes FROM thread_items WHERE thread_id = ? AND item_type = 'userMessage' ORDER BY rollout_ordinal ASC LIMIT 1",
    );
    const firstUserBytes = database.prepare(
      "SELECT rollout_ordinal, LENGTH(CAST(item_json AS BLOB)) AS bytes FROM thread_items WHERE thread_id = ? AND item_type = 'userMessage' ORDER BY rollout_ordinal ASC LIMIT 1",
    );
    return {
      read: (threadId) => {
        // One read transaction keeps the size checks and the fetched rows on the same snapshot
        // while Codex keeps writing.
        try {
          database.exec("BEGIN");
        } catch (cause) {
          return { _tag: "Failed" as const, cause };
        }
        try {
          const total = Number(
            (count.get(threadId) as { readonly count?: unknown } | undefined)?.count ?? 0,
          );
          const bytesBeforeRows = Number(
            (
              recentBytes.get(threadId, MAX_CODEX_HISTORY_MESSAGES) as
                | { readonly bytes?: unknown }
                | undefined
            )?.bytes ?? 0,
          );
          if (bytesBeforeRows > maxBytes) return { _tag: "TooLarge" as const };
          const rows = recent.all(
            threadId,
            MAX_CODEX_HISTORY_MESSAGES,
          ) as unknown as ReadonlyArray<HistoryRow>;
          let bytes = bytesBeforeRows;
          const texts = rows.toReversed().map((row) => messageText(row.item_type, row.item_json));
          if (texts.includes(undefined)) {
            return { _tag: "Failed" as const, cause: UNSUPPORTED_MESSAGE };
          }
          const parsed = rows
            .toReversed()
            .flatMap((row, index): Array<CodexHistoryMessage & { readonly ordinal: number }> => {
              const text = texts[index] ?? "";
              if (text.length === 0) return [];
              const ordinal = Number(row.rollout_ordinal);
              return [
                {
                  role: row.item_type === "userMessage" ? "user" : "assistant",
                  text,
                  createdAtMs: toMs(row.created_at_ms, 0),
                  ordinal: Number.isSafeInteger(ordinal) ? ordinal : index,
                },
              ];
            });
          if (parsed.length === 0) return { _tag: "Empty" as const };
          const oldest = parsed[0]?.ordinal;
          let retained = parsed;
          const firstMeta = firstUserBytes.get(threadId) as
            | { readonly rollout_ordinal?: unknown; readonly bytes?: unknown }
            | undefined;
          if (
            firstMeta !== undefined &&
            oldest !== undefined &&
            Number(firstMeta.rollout_ordinal) < oldest
          ) {
            if (bytes + Number(firstMeta.bytes ?? 0) > maxBytes) {
              return { _tag: "TooLarge" as const };
            }
            const first = firstUser.get(threadId) as HistoryRow | undefined;
            if (first === undefined) return { _tag: "Empty" as const };
            const firstText = messageText(first.item_type, first.item_json);
            if (firstText === undefined) {
              return { _tag: "Failed" as const, cause: UNSUPPORTED_MESSAGE };
            }
            if (firstText.length > 0) {
              bytes += Number(first.bytes ?? 0);
              retained = [
                {
                  role: "user" as const,
                  text: firstText,
                  createdAtMs: toMs(first.created_at_ms, 0),
                  ordinal: Number(first.rollout_ordinal),
                },
                ...parsed.slice(-(MAX_CODEX_HISTORY_MESSAGES - 1)),
              ];
            }
          }
          const messages = retained.map(({ ordinal: _ordinal, ...message }) => message);
          if (!messages.some((message) => message.role === "user")) {
            return { _tag: "Empty" as const };
          }
          return {
            _tag: "Ok" as const,
            data: {
              messages,
              omittedMessageCount: Math.max(0, total - messages.length),
              createdAtMs: messages[0]?.createdAtMs ?? 0,
              bytes,
            },
          };
        } catch (cause) {
          return { _tag: "Failed" as const, cause };
        } finally {
          try {
            database.exec("COMMIT");
          } catch {
            // A failed COMMIT of a read-only transaction leaves nothing to undo.
          }
        }
      },
      close: () => database.close(),
    };
  } catch {
    database.close();
    return null;
  }
}

function iso(ms: number, fallback: string): string {
  if (ms === 0 || Math.abs(ms) > MAX_DATE_MS) return fallback;
  return DateTime.formatIso(DateTime.makeUnsafe(ms));
}

function titleFor(thread: CodexHistoryThreadRef, data: CodexHistoryThreadData): string {
  const saved = thread.title.trim().split("\n")[0]?.slice(0, 100).trim();
  if (saved) return saved;
  const first = data.messages.find((message) => message.role === "user")?.text;
  return first?.trim().split("\n")[0]?.slice(0, 100).trim() || "Imported thread";
}

export function codexHistoryThreadSource(
  thread: CodexHistoryThreadRef,
  providerInstanceId: ProviderInstanceId,
): AgentSessionImportSource {
  return {
    provider: "codex",
    providerInstanceId,
    providerSessionId: thread.id,
    filePath: codexHistorySourcePath(thread.id),
    size: 0,
    mtimeMs: null,
    device: 0,
    inode: null,
    birthtimeMs: null,
  };
}

export function codexHistorySourcePath(threadId: string): string {
  return `codex-history://${threadId}`;
}

export function codexHistoryThread(
  thread: CodexHistoryThreadRef,
  data: CodexHistoryThreadData,
  providerInstanceId: ProviderInstanceId,
): AgentSessionThread {
  const updatedAt = iso(thread.updatedAtMs, "1970-01-01T00:00:00.000Z");
  const createdAt = iso(data.createdAtMs || thread.createdAtMs, updatedAt);
  return {
    source: "codex",
    providerInstanceId,
    providerSessionId: thread.id,
    title: titleFor(thread, data),
    model: thread.model?.trim() || null,
    createdAt,
    updatedAt,
    messages: data.messages.map((message) => ({
      role: message.role,
      text: message.text,
      createdAt: iso(message.createdAtMs, createdAt),
    })),
    omittedMessageCount: data.omittedMessageCount,
  };
}
