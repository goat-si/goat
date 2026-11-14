import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as McpProviderSession from "@goat/provider-core/server/mcpSession";

/**
 * OpenCode skips every tool of a server whose name is over 64 characters (its
 * tool namespace limit), and its router rejects adding one over 100, so a
 * thread id that does not fit, or whose sanitization is lossy, is replaced by
 * a digest of the original id so shortening the prefix cannot merge names.
 */
export const goatMcpServerName = Effect.fn("goatMcpServerName")(function* (threadId: string) {
  const sanitized = threadId.replaceAll(/[^a-zA-Z0-9_-]/g, "_");
  const name = `goat-${sanitized}`;
  // Keep the readable-id ceiling the t3-code- prefix had (56), so a shorter
  // prefix never makes more ids readable and widens own-thread wildcards.
  if (sanitized === threadId && sanitized.length <= 56) return name;
  const crypto = yield* Crypto.Crypto;
  const digest = yield* crypto
    .digest("SHA-256", new TextEncoder().encode(threadId))
    .pipe(Effect.orDie);
  return `goat-${Hex.encode(digest).slice(0, 16)}`;
});

/**
 * The thread's managed Cua Driver, registered per directory beside its GOAT
 * server. Always a digest: a readable id would exceed OpenCode's 64-character
 * tool namespace with this longer prefix.
 */
export const cuaMcpServerName = Effect.fn("cuaMcpServerName")(function* (threadId: string) {
  const crypto = yield* Crypto.Crypto;
  const digest = yield* crypto
    .digest("SHA-256", new TextEncoder().encode(threadId))
    .pipe(Effect.orDie);
  return `${McpProviderSession.CUA_MCP_SERVER_NAME}-${Hex.encode(digest).slice(0, 16)}`;
});
