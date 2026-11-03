# 010 — wp1: message-channel transport + UDS WebSocket connector

Goal: CodexAppServerClient can run over a WebSocket on a Unix socket with the same protocol layer as stdio.
Criteria fed: groundwork for c-2/c-3; resource parity part of c-6.

## 1. packages/effect-codex-app-server/src/_internal/messageChannel.ts (NEW, ~80 lines)
```ts
/** One complete JSON-RPC message per item, both directions. */
export interface CodexAppServerMessageChannel {
  readonly incoming: Stream.Stream<string, CodexError.CodexAppServerError>; // ends when the peer closes
  readonly send: (message: string) => Effect.Effect<void, CodexError.CodexAppServerError>;
  /** Resolves with why the channel closed (code/reason), used as the termination error. */
  readonly closed: Effect.Effect<CodexError.CodexAppServerError>;
}
export const makeMessageChannelStdio = (channel: CodexAppServerMessageChannel): Stdio.Stdio
```
- stdin: channel.incoming mapped to encoder.encode(message + "\n"). Reject a message containing a raw "\n" with
  CodexAppServerTransportError({operation:"read-input-stream"}) (compact JSON never has one; protects framing).
- stdout(): Sink that buffers string|Uint8Array chunks, splits on "\n", and calls channel.send(line) for each complete non-empty line
  (the protocol writes one JSON line per message; buffer anyway).
- stderr(): Sink.drain.

## 2. packages/effect-codex-app-server/src/client.ts (MODIFY, after layerChildProcess at :308)
```ts
export const layerMessageChannel = (
  channel: CodexAppServerMessageChannel,
  options: CodexAppServerClientOptions = {},
): Layer.Layer<CodexAppServerClient> =>
  Layer.effect(CodexAppServerClient, make(makeMessageChannelStdio(channel), options, channel.closed));
export type { CodexAppServerMessageChannel } from "./_internal/messageChannel.ts";
```
No new package dependency (effect only).

## 3. apps/server/src/provider/CodexAppServerSocket.ts (NEW, ~150 lines; GOAT-owned)
```ts
export const CODEX_SOCKET_FRAGMENT_BYTES = 8 * 1024 * 1024; // < Codex max_frame_size 16 MiB
export const CODEX_SOCKET_MAX_MESSAGE_BYTES = 64 * 1024 * 1024; // Codex max_message_size
export const connectCodexAppServerSocket: (socketPath: string) =>
  Effect.Effect<CodexAppServerMessageChannel, CodexAppServerSocketError, Scope.Scope>
```
- new WebSocket(`ws+unix://${socketPath}:/`, {perMessageDeflate:false, maxPayload: 0x7fffffff, followRedirects:false}); no Origin header.
- acquireRelease: release = ws.close(1000) then terminate() if not closed (scoped, no timers in tests).
- open/error before open -> CodexAppServerSocketError({socketPath, cause}) (tagged, Schema.TaggedError).
- incoming: Stream.callback from 'message' (Buffer|string -> utf8 string); end on 'close'.
- send(message): byteLength > CODEX_SOCKET_MAX_MESSAGE_BYTES -> fail CodexAppServerTransportError("Message exceeds Codex's
  64 MiB limit"); else split the UTF-8 Buffer into <= 8 MiB chunks: ws.send(chunk, {binary:false, fin: last}) — fragments must split
  on bytes, Codex reassembles; await send callback.
- closed: Deferred completed on 'close' with CodexAppServerTransportError({operation:"read-input-stream", cause: new Error(
  `Codex app-server socket closed (${code}${reason ? ": " + reason : ""})`)}).
- apps/server/package.json: add "ws": "catalog:" and devDependency "@types/ws" if the catalog has it (else rely on ws types bundling;
  check before adding). C4 note: new direct dependency already in the lockfile at 8.22.0.

## Tests (failing first)
- packages/effect-codex-app-server/src/client.test.ts: "a client over a message channel round-trips requests and reports the
  channel's close as termination" — in-memory channel (Queue incoming, Queue sent); assert request/response, notification handler
  delivery, and terminated == closed error after the incoming stream ends.
- apps/server/src/provider/CodexAppServerSocket.test.ts (it.live: real UDS fixture with ws.WebSocketServer({server: http over
  net.createServer on a temp socket path})): "a message over one frame limit is sent fragmented and reassembled", asserting the server
  received fin=false fragments (count > 1) for a 20 MB payload and one reassembled message; "the socket's close becomes the termination
  error". it.live is allowed: socket fixture.
Commands: vp test run packages/effect-codex-app-server/src/client.test.ts apps/server/src/provider/CodexAppServerSocket.test.ts;
vp run typecheck (affected packages).

