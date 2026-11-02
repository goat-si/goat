import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as CodexError from "effect-codex-app-server/errors";
import type { CodexAppServerMessageChannel } from "effect-codex-app-server/client";
import WebSocket from "ws";

const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
const FRAGMENT_BYTES = 8 * 1024 * 1024;

export class CodexAppServerSocketError extends Schema.TaggedError<CodexAppServerSocketError>()(
  "CodexAppServerSocketError",
  { cause: Schema.Defect() },
) {}

export const connectCodexAppServerSocket = Effect.fn("CodexAppServerSocket.connect")(function* (
  socketPath: string,
) {
  const incoming = yield* Queue.unbounded<string, Cause.Done<void>>();
  const closed = yield* Deferred.make<CodexError.CodexAppServerError>();
  const gate = yield* Semaphore.make(1);
  const ws = yield* Effect.acquireRelease(
    Effect.sync(
      () =>
        new WebSocket(`ws+unix://${socketPath}:/`, {
          perMessageDeflate: false,
          maxPayload: 80 * 1024 * 1024,
        }),
    ),
    (socket) =>
      Effect.sync(() => {
        socket.close(1000);
        if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
      }),
  );
  const finish = (cause: unknown) => {
    const error = new CodexError.CodexAppServerTransportError({
      operation: "read-input-stream",
      cause,
    });
    Deferred.doneUnsafe(closed, Effect.succeed(error));
    Queue.endUnsafe(incoming);
  };
  ws.on("message", (data) => {
    Queue.offerUnsafe(incoming, data.toString());
  });
  ws.on("close", (code, reason) =>
    finish(new Error(`WebSocket closed (${code}): ${reason.toString()}`)),
  );
  ws.on("error", (error) => finish(error));
  yield* Effect.callback<void, CodexAppServerSocketError>((resume) => {
    ws.once("open", () => resume(Effect.void));
    ws.once("error", (cause) => resume(Effect.fail(new CodexAppServerSocketError({ cause }))));
  });
  const send = Effect.fn("CodexAppServerSocket.send")(
    function* (message: string) {
      const bytes = Buffer.from(message, "utf8");
      if (bytes.length > MAX_MESSAGE_BYTES) {
        return yield* new CodexError.CodexAppServerTransportError({
          operation: "encode-outgoing-message",
          cause: new Error(
            `Message is ${bytes.length} bytes; the Codex socket accepts at most ${MAX_MESSAGE_BYTES}.`,
          ),
        });
      }
      for (let offset = 0; offset < bytes.length || offset === 0; offset += FRAGMENT_BYTES) {
        const chunk = bytes.subarray(offset, offset + FRAGMENT_BYTES);
        yield* Effect.callback<void, CodexError.CodexAppServerError>((resume) => {
          ws.send(
            chunk,
            { binary: false, fin: offset + FRAGMENT_BYTES >= bytes.length },
            (cause) => {
              resume(
                cause
                  ? Effect.fail(
                      new CodexError.CodexAppServerTransportError({
                        operation: "write-output-stream",
                        cause,
                      }),
                    )
                  : Effect.void,
              );
            },
          );
        });
      }
    },
    Effect.uninterruptible,
    gate.withPermits(1),
  );
  return {
    incoming: Stream.fromQueue(incoming),
    send,
    closed: Deferred.await(closed),
  } satisfies CodexAppServerMessageChannel;
});
