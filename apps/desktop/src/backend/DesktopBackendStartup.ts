import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";

export interface BackendStartupFailure {
  readonly reason: string;
  readonly output: string;
}

const OUTPUT_TAIL_CHARS = 4_000;

export const makeStartupFailureReporter = Effect.fn("desktop.backendStartup.makeReporter")(
  function* (onFailure?: (failure: BackendStartupFailure) => Effect.Effect<void>) {
    if (onFailure === undefined) {
      return {
        reset: Effect.void,
        append: (_stream: "stdout" | "stderr", _chunk: Uint8Array) => Effect.void,
        report: (_reason: string) => Effect.void,
      };
    }
    const tail = yield* Ref.make("");
    const decoders = () => ({ stdout: new TextDecoder(), stderr: new TextDecoder() });
    let outputDecoders = decoders();
    return {
      reset: Ref.set(tail, "").pipe(
        Effect.andThen(
          Effect.sync(() => {
            outputDecoders = decoders();
          }),
        ),
      ),
      append: (stream: "stdout" | "stderr", chunk: Uint8Array) =>
        Ref.update(tail, (text) =>
          // The tail can cut a surrogate pair; data URLs require well-formed Unicode.
          (text + outputDecoders[stream].decode(chunk, { stream: true }))
            .slice(-OUTPUT_TAIL_CHARS)
            .toWellFormed(),
        ),
      report: (reason: string) =>
        Ref.get(tail).pipe(
          Effect.flatMap((output) => onFailure?.({ reason, output }) ?? Effect.void),
        ),
    };
  },
);

export function makeBackendReadinessWait(
  snapshot: Effect.Effect<{ readonly desiredRunning: boolean; readonly ready: boolean }>,
) {
  return Effect.fn("DesktopBackendManager.waitForReady")(
    function* (_timeout: Duration.Duration) {
      const current = yield* snapshot;
      if (!current.desiredRunning) return { done: true, ready: false };
      return current.ready ? { done: true, ready: true } : { done: false, ready: false };
    },
    (effect, timeout) =>
      effect.pipe(
        Effect.repeat({
          until: (status) => status.done,
          schedule: Schedule.spaced(Duration.millis(100)),
        }),
        Effect.map((status) => status.ready),
        Effect.timeoutOption(timeout),
        Effect.map(Option.getOrElse(() => false)),
      ),
  );
}

export const markBackendReady = Effect.fn("desktop.backendStartup.markReady")(
  (
    mutex: import("effect/Semaphore").Semaphore,
    state: Ref.Ref<import("./DesktopBackendProcess.ts").BackendManagerState>,
    runId: number,
    blocked: () => boolean,
    onReady: Effect.Effect<void>,
  ) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const accepted = yield* Ref.modify(state, (latest) => {
          const active = Option.getOrUndefined(latest.active);
          return active?.id !== runId || active.stopRequested || !latest.desiredRunning || blocked()
            ? ([false, latest] as const)
            : ([true, { ...latest, ready: true, startupRetryAttempt: 0 }] as const);
        });
        if (accepted) yield* onReady;
        return accepted;
      }),
    ),
);

export const reportStartupFailureIfCurrent = Effect.fn("desktop.backendStartup.reportIfCurrent")(
  (
    mutex: import("effect/Semaphore").Semaphore,
    state: Ref.Ref<import("./DesktopBackendProcess.ts").BackendManagerState>,
    runId: number,
    report: Effect.Effect<void>,
  ) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        const active = Option.getOrUndefined(current.active);
        if (
          active?.id === runId &&
          !active.stopRequested &&
          current.desiredRunning &&
          !current.ready
        )
          yield* report;
      }),
    ),
);
