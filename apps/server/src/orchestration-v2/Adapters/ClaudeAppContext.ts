import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ProviderDriverKind } from "@goat/contracts";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import { encodeClaudeJson } from "./ClaudeAgentSdkQueryRunner.ts";
import type { reserveClaudePdfBudget } from "./ClaudeAttachmentBudget.ts";

const MAX_APP_CONTEXT_SESSIONS = 64;
const MAX_APP_CONTEXT_ENTRIES = 64;
const MAX_APP_CONTEXT_BYTES = 256 * 1024;
type Entry = { readonly key: string; readonly text: string };
type Reservation = Effect.Success<ReturnType<typeof reserveClaudePdfBudget>>;

export function makeClaudeAppContextDelivery() {
  const delivered = new Map<string, ReadonlyMap<string, string>>();
  const prepare = Effect.fn("ClaudeAppContext.prepare")(function* (
    session: string,
    prompt: string,
    entries: ReadonlyArray<Entry>,
    reservation: Reservation,
  ) {
    if (prompt.trimStart().startsWith("/")) return undefined;
    const previous = delivered.get(session);
    const snapshot = new Map(previous);
    const blocks: Array<{ type: "text"; text: string }> = [];
    let bytes = 0;
    for (const entry of entries) {
      if (entry.key === "goat_memory" || previous?.get(entry.key) === entry.text) continue;
      const key = entry.key.replace(/[^a-zA-Z0-9_.-]/gu, "_");
      const text = entry.text
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
      const block = { type: "text" as const, text: `<external_${key}>${text}</external_${key}>` };
      bytes += Buffer.byteLength(encodeClaudeJson(block)) + 1;
      if (blocks.length >= MAX_APP_CONTEXT_ENTRIES || bytes > MAX_APP_CONTEXT_BYTES) {
        return yield* new ProviderAdapter.ProviderAdapterProtocolError({
          driver: ProviderDriverKind.make("claudeAgent"),
          detail: "MCP app context exceeds the Claude prompt limit.",
        });
      }
      blocks.push(block);
      snapshot.delete(entry.key);
      snapshot.set(entry.key, entry.text);
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
    clear: (session: string) => {
      delivered.delete(session);
    },
    commit: (session: string, snapshot: ReadonlyMap<string, string>) => {
      delivered.delete(session);
      delivered.set(session, snapshot);
      if (delivered.size > MAX_APP_CONTEXT_SESSIONS) {
        const oldest = delivered.keys().next();
        if (!oldest.done) delivered.delete(oldest.value);
      }
    },
  };
}
