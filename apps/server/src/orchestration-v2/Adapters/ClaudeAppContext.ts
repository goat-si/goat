// @effect-diagnostics-next-line nodeBuiltinImport:off -- A synchronous digest inside the pure note filter.
import * as NodeCrypto from "node:crypto";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { type OrchestrationV2ProviderThread, ProviderDriverKind } from "@goat/contracts";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import { encodeClaudeJson } from "./ClaudeAgentSdkQueryRunner.ts";
import type { reserveClaudePdfBudget } from "./ClaudeAttachmentBudget.ts";

const MAX_APP_CONTEXT_SESSIONS = 64;
const MAX_APP_CONTEXT_ENTRIES = 64;
const MAX_APP_CONTEXT_BYTES = 256 * 1024;
type Entry = { readonly key: string; readonly text: string; readonly updatedAt?: string };
type Reservation = Effect.Success<ReturnType<typeof reserveClaudePdfBudget>>;

// Digests keep the persisted record of delivered notes small; notes can be 16 KiB each.
const digestAppContextText = (text: string): string =>
  NodeCrypto.createHash("sha256").update(text).digest("base64url");

const escapeXmlAttr = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

export function makeClaudeAppContextDelivery() {
  // Digests of MCP app notes already in each native session's history, by key. Cleared when it
  // compacts; persisted in native metadata so a restarted server does not resend them.
  const delivered = new Map<string, ReadonlyMap<string, string>>();
  const setSession = (session: string, snapshot: ReadonlyMap<string, string>) => {
    delivered.delete(session);
    delivered.set(session, snapshot);
    if (delivered.size > MAX_APP_CONTEXT_SESSIONS) {
      const oldest = delivered.keys().next();
      if (!oldest.done) delivered.delete(oldest.value);
    }
  };
  const prepare = Effect.fn("ClaudeAppContext.prepare")(function* (
    session: string,
    prompt: string,
    entries: ReadonlyArray<Entry>,
    reservation: Reservation,
    offered?: ReadonlyMap<string, string>,
  ) {
    if (prompt.trimStart().startsWith("/")) return undefined;
    const previous = offered ?? delivered.get(session);
    const snapshot = new Map(previous);
    const blocks: Array<{ type: "text"; text: string }> = [];
    let bytes = 0;
    for (const entry of entries) {
      if (entry.key === "goat_memory") continue;
      const digest = digestAppContextText(entry.text);
      if (previous?.get(entry.key) === digest) continue;
      const key = entry.key.replace(/[^a-zA-Z0-9_.-]/gu, "_");
      const text = entry.text
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
      const updatedAt =
        entry.updatedAt === undefined ? "" : ` updated_at="${escapeXmlAttr(entry.updatedAt)}"`;
      const block = {
        type: "text" as const,
        text: `<external_${key}${updatedAt}>${text}</external_${key}>`,
      };
      bytes += Buffer.byteLength(encodeClaudeJson(block)) + 1;
      if (blocks.length >= MAX_APP_CONTEXT_ENTRIES || bytes > MAX_APP_CONTEXT_BYTES) {
        return yield* new ProviderAdapter.ProviderAdapterProtocolError({
          driver: ProviderDriverKind.make("claudeAgent"),
          detail: "MCP app context exceeds the Claude prompt limit.",
        });
      }
      blocks.push(block);
      snapshot.delete(entry.key);
      snapshot.set(entry.key, digest);
    }
    if (blocks.length === 0) return undefined;
    if (bytes > reservation.budget.remainingBytes) {
      return yield* new ProviderAdapter.ProviderAdapterProtocolError({
        driver: ProviderDriverKind.make("claudeAgent"),
        detail: "MCP app context exceeds the remaining Claude attachment budget.",
      });
    }
    let snapshotBytes = [...snapshot].reduce(
      (sum, [key, value]) => sum + Buffer.byteLength(key) + Buffer.byteLength(value),
      0,
    );
    while (snapshot.size > MAX_APP_CONTEXT_ENTRIES || snapshotBytes > MAX_APP_CONTEXT_BYTES) {
      const oldest = snapshot.keys().next();
      if (oldest.done) break;
      snapshotBytes -=
        Buffer.byteLength(oldest.value) + Buffer.byteLength(snapshot.get(oldest.value) ?? "");
      snapshot.delete(oldest.value);
    }
    reservation.budget.pending.bytes += bytes;
    reservation.bytes += bytes;
    return {
      snapshot,
      apply(message: SDKUserMessage): SDKUserMessage {
        const content = message.message.content;
        return {
          ...message,
          message: {
            ...message.message,
            content: [
              ...blocks,
              ...(typeof content === "string"
                ? [{ type: "text" as const, text: content }]
                : content),
            ],
          },
        };
      },
    };
  });
  return {
    prepare,
    hydrate: (session: string, recorded: Readonly<Record<string, string>> | undefined) => {
      if (!delivered.has(session) && recorded !== undefined) {
        setSession(session, new Map(Object.entries(recorded)));
      }
    },
    clear: (session: string) => {
      setSession(session, new Map());
    },
    commit: setSession,
    applyNativeMetadata(
      providerThread: OrchestrationV2ProviderThread,
    ): OrchestrationV2ProviderThread {
      const nativeThreadId = providerThread.nativeThreadRef?.nativeId;
      const entries =
        nativeThreadId === undefined || nativeThreadId === null
          ? undefined
          : delivered.get(nativeThreadId);
      if (entries === undefined) return providerThread;
      const { claudeDeliveredAppContext: _recorded, ...nativeMetadata } =
        providerThread.nativeMetadata ?? {};
      return {
        ...providerThread,
        nativeMetadata: {
          ...nativeMetadata,
          ...(entries.size === 0 ? {} : { claudeDeliveredAppContext: Object.fromEntries(entries) }),
        },
      };
    },
    clearNativeMetadata(
      providerThread: OrchestrationV2ProviderThread,
    ): OrchestrationV2ProviderThread {
      if (providerThread.nativeMetadata === null || providerThread.nativeMetadata === undefined) {
        return providerThread;
      }
      const { claudeDeliveredAppContext: _recorded, ...nativeMetadata } =
        providerThread.nativeMetadata;
      return { ...providerThread, nativeMetadata };
    },
  };
}
