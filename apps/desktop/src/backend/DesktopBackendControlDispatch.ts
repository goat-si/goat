import type { DesktopTelemetryControlMessage } from "@goat/contracts";
import { DesktopTelemetryControlMessage as ControlSchema } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
const encode = Schema.encodeSync(Schema.fromJsonString(ControlSchema));
export const makeControlDispatch = Effect.fn("DesktopBackendControlDispatch.make")(
  function* (options: {
    readonly handle: (message: DesktopTelemetryControlMessage) => Effect.Effect<void>;
    readonly onFailure: () => Effect.Effect<void>;
  }) {
    const wake = yield* Queue.bounded<void>(1);
    const failures = yield* Queue.bounded<void>(1);
    yield* Queue.take(failures).pipe(Effect.andThen(options.onFailure()), Effect.forkScoped);
    const pending: Array<{ message: DesktopTelemetryControlMessage; bytes: number }> = [];
    let bytes = 0;
    let active = 0;
    let closed = false;
    let disposed = false;
    let ending: Deferred.Deferred<void> | undefined;
    const shutdown = Effect.sync(() => {
      closed = true;
      disposed = true;
      bytes -= pending.reduce((sum, item) => sum + item.bytes, 0);
      pending.length = 0;
      if (ending) Deferred.doneUnsafe(ending, Effect.void);
    });
    yield* Effect.addFinalizer(() => shutdown);
    yield* Queue.take(wake).pipe(
      Effect.andThen(
        Effect.suspend(() => {
          const item = pending.shift();
          if (!item || disposed) return Effect.void;
          active = 1;
          return options.handle(item.message).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                active = 0;
                bytes -= item.bytes;
                if (pending.length > 0) Queue.offerUnsafe(wake, undefined);
                else if (ending) Deferred.doneUnsafe(ending, Effect.void);
              }),
            ),
          );
        }),
      ),
      Effect.forever,
      Effect.catchCause(() => shutdown.pipe(Effect.andThen(Queue.offer(failures, undefined)))),
      Effect.forkScoped,
    );
    const offer = Effect.fn("DesktopBackendControlDispatch.offer")(
      (message: DesktopTelemetryControlMessage) =>
        Effect.sync(() => {
          if (closed) return false;
          const size = new TextEncoder().encode(encode(message)).byteLength + 1;
          const coalesces =
            message.type === "setDiagnosticsDemand" || message.type === "setHostPowerIntervals";
          const index = coalesces
            ? pending.findIndex((entry) => entry.message.type === message.type)
            : -1;
          const old = index >= 0 ? pending[index] : undefined;
          if (
            size + bytes - (old?.bytes ?? 0) > 65536 ||
            (index < 0 && active + pending.length >= 32)
          ) {
            closed = true;
            disposed = true;
            bytes -= pending.reduce((sum, item) => sum + item.bytes, 0);
            pending.length = 0;
            Queue.offerUnsafe(failures, undefined);
            return false;
          }
          bytes += size - (old?.bytes ?? 0);
          if (index >= 0) pending[index] = { message, bytes: size };
          else pending.push({ message, bytes: size });
          Queue.offerUnsafe(wake, undefined);
          return true;
        }),
    );
    return {
      offer,
      shutdown,
      end: Effect.suspend(() => {
        closed = true;
        if (disposed) return Effect.void;
        if (active === 0 && pending.length === 0) return Effect.void;
        return Deferred.make<void>().pipe(
          Effect.flatMap((done) => {
            ending = done;
            return Deferred.await(done);
          }),
        );
      }),
      state: Effect.sync(() => ({ frames: active + pending.length, bytes, closed })),
    };
  },
);

export function makeControlLineFramer() {
  const bytes = new Uint8Array(65536);
  let length = 0;
  return (chunk: Uint8Array) => {
    const lines: string[] = [];
    for (const byte of chunk) {
      if (byte === 10) {
        lines.push(new TextDecoder().decode(bytes.subarray(0, length)));
        length = 0;
      } else {
        if (length === bytes.length) throw new Error("Desktop control frame exceeds 64 KiB");
        bytes[length++] = byte;
      }
    }
    return lines;
  };
}
