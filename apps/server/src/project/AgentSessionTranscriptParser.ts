import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import type { ProviderInstanceId } from "@goat/contracts";
import type {
  AgentSessionSource,
  AgentSessionThread,
  AgentSessionThreadMessage,
} from "./AgentSessionScanner.ts";
import {
  TranscriptContentBlock,
  TranscriptMessage,
  decodeTranscriptRecord,
  decodeCodexTurnMetadata,
  type DecodedTranscriptRecord,
} from "./AgentSessionTranscriptSchema.ts";

const MAX_IMPORTED_MESSAGES = 200;
export const MAX_IMPORT_RECORDS = 100_000;

interface AgentSessionTranscriptMetadata {
  readonly source: AgentSessionSource;
  readonly providerInstanceId: ProviderInstanceId;
  readonly fallbackSessionId: string;
  readonly lastActiveAtMs: number;
}

function splitTranscriptRecords(contents: string, limit: number): string[] {
  const records = contents.endsWith("\n") ? contents.slice(0, -1) : contents;
  return records.split("\n", limit);
}

function isTextContentBlock(block: typeof TranscriptContentBlock.Type): boolean {
  return block.type === "text" || block.type === "input_text" || block.type === "output_text";
}

function extractText(
  content: string | ReadonlyArray<typeof TranscriptContentBlock.Type> | undefined,
): string {
  if (typeof content === "string") return content.trim();
  if (content === undefined) return "";
  return content
    .filter(isTextContentBlock)
    .map((block) => block.text?.trim() ?? "")
    .filter((text) => text.length > 0)
    .join("\n");
}

function normalizeTimestamp(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  const parsed = DateTime.make(value);
  return Option.isSome(parsed) ? DateTime.formatIso(parsed.value) : fallback;
}

function codexTurnId(metadata: unknown): string | null {
  const decoded = decodeCodexTurnMetadata(metadata);
  if (
    Option.isNone(decoded) ||
    typeof decoded.value.turn_id !== "string" ||
    decoded.value.turn_id.trim().length === 0
  ) {
    return null;
  }
  return decoded.value.turn_id;
}

function isHiddenClaudeRecord(record: DecodedTranscriptRecord): boolean {
  return record.isSidechain === true || record.isMeta === true || record.isCompactSummary === true;
}

// Claude repeats session fields on records that need not be retained.
interface ClaudeFields {
  readonly sessionId: string | undefined;
  readonly title: string | undefined;
  readonly customTitle: string | null;
  readonly model: string | undefined;
}

export const emptyClaudeFields: ClaudeFields = {
  sessionId: undefined,
  title: undefined,
  customTitle: null,
  model: undefined,
};

export function foldClaudeFields(
  fields: ClaudeFields,
  record: DecodedTranscriptRecord,
): ClaudeFields {
  if (isHiddenClaudeRecord(record)) return fields;
  const model = record.message?.model?.trim();
  return {
    sessionId: record.sessionId?.trim() || fields.sessionId,
    title: record.aiTitle?.trim() || fields.title,
    // Claude flushes the AI title after the user's rename; an empty rename clears it.
    customTitle:
      record.customTitle === undefined ? fields.customTitle : record.customTitle.trim() || null,
    // Claude uses this sentinel for local error responses. It is not a
    // model ID that can be selected when the imported session resumes.
    model: model && model !== "<synthetic>" ? model : fields.model,
  };
}

// Codex records setup context as user text ahead of the real request. Skip
// these leading blocks when deriving a title; imported messages keep them.
const CODEX_TITLE_PREAMBLE =
  /^(?:\s*(?:<(recommended_plugins|environment_context|user_instructions|INSTRUCTIONS|in-app-browser-context|external_codex_apps_open_page)(?:\s[^>]*)?>[\s\S]*?<\/\1>|# AGENTS\.md instructions\b[^\n]*|## My request for Codex:))+/;

function deriveTitle(source: AgentSessionSource, text: string): string | undefined {
  const request = (source === "codex" ? text.replace(CODEX_TITLE_PREAMBLE, "") : text).replace(
    /^\s*<wake(?:\s[^>]*)?>([\s\S]*?)(?:<\/wake>|$)/,
    "$1",
  );
  const line = request.trim().split("\n")[0] ?? "";
  const split = /[\uD800-\uDBFF]/.test(line[99] ?? "") && /[\uDC00-\uDFFF]/.test(line[100] ?? "");
  return line.slice(0, split ? 99 : 100).trim() || undefined;
}

// Pi keeps abandoned branches in the file; its active branch runs from the last entry to the root.
function activePiBranch(
  records: ReadonlyArray<DecodedTranscriptRecord>,
): ReadonlyArray<DecodedTranscriptRecord> {
  const entries = records.filter((record) => record.type !== "session");
  const leaf = entries.at(-1);
  // Version 1 sessions predate the tree and are linear.
  if (leaf?.id === undefined) return entries;
  const byId = new Map(
    entries.flatMap((entry) => (entry.id === undefined ? [] : [[entry.id, entry] as const])),
  );
  const branch: Array<DecodedTranscriptRecord> = [];
  for (
    let entry: DecodedTranscriptRecord | undefined = leaf;
    entry !== undefined && branch.length < entries.length;
    entry = entry.parentId ? byId.get(entry.parentId) : undefined
  ) {
    branch.push(entry);
  }
  return branch.toReversed();
}

export function isPiConversationRecord(
  record: DecodedTranscriptRecord,
): record is DecodedTranscriptRecord & {
  readonly message: typeof TranscriptMessage.Type & { readonly role: "user" | "assistant" };
} {
  return (
    record.type === "message" &&
    (record.message?.role === "user" || record.message?.role === "assistant")
  );
}

export function parseAgentSessionTranscript(
  input: AgentSessionTranscriptMetadata & {
    readonly contents: string;
  },
  lines = splitTranscriptRecords(input.contents, MAX_IMPORT_RECORDS + 1),
): AgentSessionThread | null {
  if (lines.length > MAX_IMPORT_RECORDS) return null;
  const records = lines.flatMap((line) => Option.toArray(decodeTranscriptRecord(line)));
  const claudeFields =
    input.source === "claudeAgent"
      ? records.reduce(foldClaudeFields, emptyClaudeFields)
      : emptyClaudeFields;
  const thread = parseAgentSessionRecords(input, records, claudeFields, 0);
  return thread === "empty" ? null : thread;
}

export function parseAgentSessionRecords(
  input: AgentSessionTranscriptMetadata,
  records: ReadonlyArray<DecodedTranscriptRecord>,
  claudeFields: ClaudeFields,
  droppedMessageCount: number,
): AgentSessionThread | "empty" | null {
  const fallbackTimestamp = DateTime.formatIso(DateTime.makeUnsafe(input.lastActiveAtMs));
  // Claude filenames are session IDs. Codex rollout filenames include extra
  // timestamp text, so only transcript metadata can provide a resumable ID.
  let providerSessionId =
    input.source === "codex"
      ? ""
      : input.source === "pi"
        ? records.find((record) => record.type === "session")?.id?.trim() || input.fallbackSessionId
        : (claudeFields.sessionId ?? input.fallbackSessionId);
  // Pi titles a session by its latest session_info on any branch; an empty name clears it.
  const title =
    input.source === "pi"
      ? records.findLast((record) => record.type === "session_info")?.name?.trim() || null
      : (claudeFields.title ?? null);
  let model = claudeFields.model ?? null;
  let derivedTitle: string | undefined;
  let hasCodexSessionId = false;
  const messages: Array<AgentSessionThreadMessage & { readonly codexResponseUser: boolean }> = [];
  let firstUserMessage:
    | (AgentSessionThreadMessage & { readonly codexResponseUser: boolean })
    | undefined;
  const canonicalCodexResponseUserIndices = new Set<number>();
  let canonicalUserTextsInTurn = new Set<string>();
  let responseUsersInTurn: Array<{
    readonly index: number;
    readonly turnId: string;
    readonly text: string;
  }> = [];
  const finishCodexTurn = () => {
    const canonicalTurnIds = new Set(
      responseUsersInTurn.flatMap((responseUser) =>
        canonicalUserTextsInTurn.has(responseUser.text) ? [responseUser.turnId] : [],
      ),
    );
    for (const responseUser of responseUsersInTurn) {
      if (canonicalTurnIds.has(responseUser.turnId)) {
        canonicalCodexResponseUserIndices.add(responseUser.index);
      }
    }
    canonicalUserTextsInTurn = new Set();
    responseUsersInTurn = [];
  };
  if (input.source === "codex") {
    let recordIndex = -1;
    for (const record of records) {
      recordIndex += 1;
      if (
        record.type === "response_item" &&
        record.payload?.type === "message" &&
        record.payload.role === "assistant"
      ) {
        finishCodexTurn();
        continue;
      }
      if (record.type === "event_msg" && record.payload?.type === "user_message") {
        const text = record.payload.message?.trim() ?? "";
        if (text.length > 0) canonicalUserTextsInTurn.add(text);
        continue;
      }
      if (
        record.type === "response_item" &&
        record.payload?.type === "message" &&
        record.payload.role === "user"
      ) {
        const turnId = codexTurnId(record.payload.internal_chat_message_metadata_passthrough);
        const text = extractText(record.payload.content);
        if (turnId !== null && text.length > 0) {
          responseUsersInTurn.push({ index: recordIndex, turnId, text });
        }
      }
    }
    finishCodexTurn();
  }

  let conversationMessageCount = 0;
  const retainMessage = (
    message: AgentSessionThreadMessage & { readonly codexResponseUser: boolean },
  ) => {
    if (firstUserMessage === undefined && message.role === "user") {
      firstUserMessage = message;
    }
    if (derivedTitle === undefined && message.role === "user") {
      derivedTitle = deriveTitle(input.source, message.text);
    }
    conversationMessageCount += 1;
    messages.push(message);
    if (messages.length > MAX_IMPORTED_MESSAGES) messages.shift();
  };

  const hasMatchingCodexEventInTurn = (text: string) => {
    const comparisonText = text.trim();
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (message?.role === "assistant") return false;
      if (
        message?.role === "user" &&
        !message.codexResponseUser &&
        message.text.trim() === comparisonText
      ) {
        return true;
      }
    }
    return false;
  };

  let recordIndex = -1;
  for (const record of input.source === "pi" ? activePiBranch(records) : records) {
    recordIndex += 1;
    if (input.source === "pi") {
      if (!isPiConversationRecord(record)) continue;
      const text = extractText(record.message.content);
      if (text.length === 0) continue;
      retainMessage({
        role: record.message.role,
        text,
        createdAt: normalizeTimestamp(record.timestamp, fallbackTimestamp),
        codexResponseUser: false,
      });
      continue;
    }
    if (input.source === "claudeAgent") {
      if (isHiddenClaudeRecord(record)) continue;
      if (record.type !== "user" && record.type !== "assistant") continue;
      const text = extractText(record.message?.content);
      if (text.length === 0) continue;
      retainMessage({
        role: record.type,
        text,
        createdAt: normalizeTimestamp(record.timestamp, fallbackTimestamp),
        codexResponseUser: false,
      });
      continue;
    }

    if (record.type === "session_meta") {
      const sessionId = record.payload?.id?.trim() || record.payload?.session_id?.trim();
      if (!hasCodexSessionId && sessionId) {
        providerSessionId = sessionId;
        hasCodexSessionId = true;
      }
      continue;
    }
    if (record.type === "turn_context" && record.payload?.model?.trim()) {
      model = record.payload.model.trim();
      continue;
    }
    if (record.type === "event_msg" && record.payload?.type === "user_message") {
      const text = record.payload.message ?? "";
      if (text.trim().length === 0) continue;
      // Codex can duplicate prompts across formats; remove only matching response copies.
      for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (message?.role === "assistant") break;
        if (message?.codexResponseUser === true && message.text.trim() === text.trim()) {
          if (firstUserMessage === message) firstUserMessage = undefined;
          messages.splice(index, 1);
          conversationMessageCount -= 1;
          break;
        }
      }
      retainMessage({
        role: "user",
        text,
        createdAt: normalizeTimestamp(record.timestamp, fallbackTimestamp),
        codexResponseUser: false,
      });
      continue;
    }
    if (
      record.type !== "response_item" ||
      record.payload?.type !== "message" ||
      (record.payload.role !== "user" && record.payload.role !== "assistant")
    ) {
      continue;
    }

    const extractedText = extractText(record.payload.content);
    if (extractedText.length === 0) continue;
    if (record.payload.role === "user" && canonicalCodexResponseUserIndices.has(recordIndex)) {
      continue;
    }
    if (record.payload.role === "user" && hasMatchingCodexEventInTurn(extractedText)) {
      continue;
    }
    retainMessage({
      role: record.payload.role,
      text: extractedText,
      createdAt: normalizeTimestamp(record.timestamp, fallbackTimestamp),
      codexResponseUser: record.payload.role === "user",
    });
  }

  if (providerSessionId.trim().length === 0) return null;
  if (conversationMessageCount === 0 && droppedMessageCount === 0) return "empty";
  const visibleMessages = messages.map(
    ({ codexResponseUser: _codexResponseUser, ...message }) => message,
  );
  if (firstUserMessage === undefined) return null;
  const firstUserMessageRetained = messages.includes(firstUserMessage);
  const { codexResponseUser: _codexResponseUser, ...visibleFirstUserMessage } = firstUserMessage;
  const retainedMessages = firstUserMessageRetained
    ? visibleMessages
    : [visibleFirstUserMessage, ...visibleMessages.slice(-(MAX_IMPORTED_MESSAGES - 1))];

  return {
    source: input.source,
    providerInstanceId: input.providerInstanceId,
    providerSessionId,
    title: claudeFields.customTitle ?? title ?? derivedTitle ?? "Imported thread",
    model,
    createdAt: retainedMessages[0]?.createdAt ?? fallbackTimestamp,
    updatedAt: fallbackTimestamp,
    messages: retainedMessages,
    omittedMessageCount: conversationMessageCount + droppedMessageCount - retainedMessages.length,
  };
}

export function extractDecodedCwd(record: DecodedTranscriptRecord): string | null {
  const cwd = record.cwd?.trim() || record.payload?.cwd?.trim();
  return cwd && cwd.length > 0 ? cwd : null;
}

export function shouldRetainDecodedRecord(
  source: AgentSessionSource,
  record: DecodedTranscriptRecord,
): boolean {
  // Any Pi entry can be a link on the active branch.
  if (source === "pi") return true;
  if (source === "claudeAgent") {
    if (isHiddenClaudeRecord(record) || (record.type !== "user" && record.type !== "assistant")) {
      return false;
    }
    const content = record.message?.content;
    return typeof content === "string"
      ? content.trim().length > 0
      : (content?.some(
          (block) => isTextContentBlock(block) && (block.text?.trim().length ?? 0) > 0,
        ) ?? false);
  }
  if (extractDecodedCwd(record) !== null) return true;
  return (
    record.type === "session_meta" ||
    record.type === "turn_context" ||
    (record.type === "event_msg" && record.payload?.type === "user_message") ||
    (record.type === "response_item" &&
      record.payload?.type === "message" &&
      (record.payload.role === "user" || record.payload.role === "assistant"))
  );
}

// The import shows only the first user message and the latest messages, so a
// long Claude session holds just those and counts the rest as dropped.
export function createClaudeHistoryWindow() {
  const recent: Array<{ readonly record: DecodedTranscriptRecord; readonly bytes: number }> = [];
  let firstUser: DecodedTranscriptRecord | undefined;
  let droppedMessageCount = 0;
  return {
    // Takes a record shouldRetainDecodedRecord kept; returns the bytes it released.
    push: (record: DecodedTranscriptRecord, bytes: number): number => {
      if (firstUser === undefined && record.type === "user") firstUser = record;
      recent.push({ record, bytes });
      if (recent.length <= MAX_IMPORTED_MESSAGES) return 0;
      const evicted = recent.shift();
      if (evicted === undefined || evicted.record === firstUser) return 0;
      droppedMessageCount += 1;
      return evicted.bytes;
    },
    records: () => {
      const held = recent.map((entry) => entry.record);
      return firstUser === undefined || held.includes(firstUser) ? held : [firstUser, ...held];
    },
    droppedMessageCount: () => droppedMessageCount,
  };
}
