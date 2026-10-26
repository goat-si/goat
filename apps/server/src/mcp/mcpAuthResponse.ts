import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/http";

import * as McpSessionRegistry from "./McpSessionRegistry.ts";

export const GENERIC_REFUSAL = "A valid GOAT MCP credential is required.";
const RETRY_AT_NEXT_TURN =
  "GOAT re-authenticates the thread with a fresh credential when its next turn starts; retry this tool then.";

/** What the agent reads when its thread credential is refused. Names no thread or id. */
export const credentialRefusalMessage = (
  reason: McpSessionRegistry.McpCredentialRefusalReason,
): string => {
  switch (reason) {
    case "expired":
      return `GOAT refused this call: this thread's GOAT credential expired after GOAT stopped holding its provider session. ${RETRY_AT_NEXT_TURN}`;
    case "revoked":
      return `GOAT refused this call: GOAT closed the provider session this thread's GOAT credential belonged to. ${RETRY_AT_NEXT_TURN}`;
    case "earlier_server":
      return `GOAT refused this call: this thread's GOAT credential was issued before the GOAT server restarted or updated. ${RETRY_AT_NEXT_TURN}`;
    case "missing":
    case "unknown":
      return GENERIC_REFUSAL;
  }
};

const MAX_REFUSED_BODY_BYTES = 1024 * 1024;
/** An unauthenticated caller must not hold the read open; a slow body falls back to 401. */
const REFUSED_BODY_DEADLINE = "5 seconds";
const decodeToolCallRequest = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      jsonrpc: Schema.Literal("2.0"),
      method: Schema.Literal("tools/call"),
      id: Schema.Union([Schema.String, Schema.Number]),
    }),
  ),
);

/**
 * MCP clients turn a 401 into their own generic text ("Authentication
 * required" in Codex), so a refused tool call is answered as an error result
 * the agent can read. Only for a registry-shaped token, never a session token
 * that may still sign in through OAuth, and nothing is executed.
 */
export const refusedToolCallId = Effect.fn("McpHttpServer.refusedToolCallId")(function* (
  request: HttpServerRequest.HttpServerRequest,
) {
  const declared = request.headers["content-length"];
  if (
    request.method !== "POST" ||
    (declared !== undefined && !(Number(declared) <= MAX_REFUSED_BODY_BYTES))
  )
    return undefined;
  // Chunked bodies declare no length, so the read itself stops at the bound.
  let size = 0;
  const chunks = yield* request.stream.pipe(
    Stream.takeWhile((chunk) => (size += chunk.byteLength) <= MAX_REFUSED_BODY_BYTES),
    Stream.runCollect,
    Effect.timeoutOption(REFUSED_BODY_DEADLINE),
    Effect.option,
    Effect.map(Option.flatten),
  );
  if (Option.isNone(chunks) || size > MAX_REFUSED_BODY_BYTES) return undefined;
  return Option.getOrUndefined(
    Option.map(
      decodeToolCallRequest(Buffer.concat(chunks.value).toString("utf8")),
      (call) => call.id,
    ),
  );
});
