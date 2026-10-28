// @effect-diagnostics nodeBuiltinImport:off -- Pure path and UUID helpers do no filesystem I/O.
import * as ElectronPowerMonitor from "../electron/ElectronPowerMonitor.ts";
import * as Option from "effect/Option";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import * as FileSystem from "effect/FileSystem";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as Result from "effect/Result";
import {
  makeBackendHealthFramer,
  emptyRecoveryRecord,
  recordRestart,
  type RecoveryRecord,
} from "@goat/shared/managedRecoveryPolicy";
import { type DesktopBackendHealth } from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import type * as PlatformError from "effect/PlatformError";
import type { ChildProcessSpawner } from "effect/process";

export interface WatchdogOptions {
  readonly protocol: 1;
  readonly generation: string;
  readonly healthFd: number;
  readonly onReceipt?: (sequence: number) => void;
  readonly isCurrent?: Effect.Effect<boolean>;
  readonly onState?: (state: WatchdogState) => Effect.Effect<void>;
  readonly onStatus?: (state: WatchdogState) => void;
  readonly onSustainedHealth?: Effect.Effect<void>;
}
export type WatchdogState =
  | "starting"
  | "startup-slow"
  | "running"
  | "suspect"
  | "health-channel-unavailable"
  | "retiring"
  | "blocked";
export const makeBackendWatchdog = Effect.fn("DesktopBackendWatchdog.make")(function* (
  options: WatchdogOptions,
  handle: ChildProcessSpawner.ChildProcessHandle,
) {
  const latch = yield* Queue.bounded<void>(1);
  const exited = yield* Deferred.make<void>();
  let disarmed = false;
  let committed = false;
  let observerSequence = 0;
  let mainSequence = -1;
  let status: WatchdogState = "starting";
  const setStatus = (next: WatchdogState) => {
    if (next !== status) {
      status = next;
      options.onStatus?.(next);
    }
  };
  const clock = yield* Clock.Clock;
  const nowMs = () => Number(clock.monotonicTimeNanosUnsafe()) / 1_000_000;
  let receivedAt = nowMs();
  let observedAt = receivedAt;
  let transportAvailable = false;
  const startedAt = receivedAt;
  let everReady = false;
  const resumed = yield* Queue.bounded<void>(1);
  let lastTick = receivedAt;
  let eligibleAt = receivedAt;
  let suspended = false;
  let healthySince: number | undefined;
  const power = yield* Effect.serviceOption(ElectronPowerMonitor.ElectronPowerMonitor);
  if (Option.isSome(power)) {
    yield* power.value.onSimpleEvent("suspend", () => {
      suspended = true;
      healthySince = undefined;
    });
    yield* power.value.onSimpleEvent("resume", () => {
      suspended = false;
      eligibleAt = nowMs() + 45000;
      lastTick = nowMs();
      Queue.offerUnsafe(resumed, undefined);
    });
  }
  const notify = Effect.suspend(() => options.onState?.(status) ?? Effect.void);
  const disarm = Effect.sync(() => {
    disarmed = true;
  });
  yield* Effect.addFinalizer(() => disarm);
  const current = Effect.suspend(() =>
    disarmed ? Effect.succeed(false) : (options.isCurrent ?? Effect.succeed(true)),
  );
  const signal = (name: "SIGTERM" | "SIGKILL") =>
    current.pipe(
      Effect.flatMap((valid) =>
        valid ? handle.kill({ killSignal: name }).pipe(Effect.ignore) : Effect.void,
      ),
    );
  yield* Queue.take(latch).pipe(
    Effect.andThen(
      Effect.gen(function* () {
        if (!(yield* current)) return;
        // oxlint-disable-next-line eslint/no-unmodified-loop-condition -- Native resume callbacks change suspension.
        while (suspended || nowMs() < eligibleAt) {
          if (suspended) yield* Queue.take(resumed);
          else yield* Effect.sleep(Math.max(0, eligibleAt - nowMs()));
        }
        if (suspended || !(yield* current)) return;
        setStatus("retiring");
        yield* notify.pipe(Effect.forkScoped);
        yield* signal("SIGTERM").pipe(Effect.forkScoped({ startImmediately: true }));
        const terminated = yield* Deferred.await(exited).pipe(Effect.timeoutOption("5 seconds"));
        if (terminated._tag === "Some" || !(yield* current)) return;
        yield* signal("SIGKILL").pipe(Effect.forkScoped({ startImmediately: true }));
        const killed = yield* Deferred.await(exited).pipe(Effect.timeoutOption("5 seconds"));
        if (killed._tag === "None" && (yield* current)) {
          setStatus("blocked");
          yield* notify;
        }
      }),
    ),
    Effect.forkScoped,
  );
  const receive = Effect.fn("DesktopBackendWatchdog.receive")((frame: DesktopBackendHealth) =>
    Effect.sync(() => {
      if (
        disarmed ||
        committed ||
        frame.generation !== options.generation ||
        frame.observerSequence <= observerSequence ||
        frame.mainSequence < mainSequence
      )
        return;
      if (nowMs() - lastTick > 10000) {
        eligibleAt = nowMs() + 45000;
        lastTick = nowMs();
      }
      if (
        frame.verdict === "main-silent" &&
        !everReady &&
        frame.phase !== "ready" &&
        nowMs() - startedAt < 1845000
      )
        return;
      observerSequence = frame.observerSequence;
      observedAt = nowMs();
      transportAvailable = true;
      if (frame.verdict === "main-silent") {
        committed = true;
        Queue.offerUnsafe(latch, undefined);
      } else if (frame.mainSequence > mainSequence) {
        mainSequence = frame.mainSequence;
        receivedAt = nowMs();
        if (frame.phase === "ready") healthySince ??= receivedAt;
        else healthySince = undefined;
        everReady ||= frame.phase === "ready";
        setStatus(
          everReady ? "running" : nowMs() - startedAt >= 1800000 ? "startup-slow" : "starting",
        );
      }
      options.onReceipt?.(observerSequence);
    }),
  );
  const read = (stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) => {
    const framer = makeBackendHealthFramer();
    return stream.pipe(
      Stream.runForEach((chunk) =>
        Effect.try(() => framer.push(chunk)).pipe(
          Effect.flatMap((frames) => Effect.forEach(frames, receive, { discard: true })),
        ),
      ),
      Effect.andThen(Effect.try(() => framer.end())),
      Effect.catchCause(() =>
        Effect.sync(() => {
          if (!committed && !disarmed) setStatus("health-channel-unavailable");
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          transportAvailable = false;
          if (!committed && !disarmed) setStatus("health-channel-unavailable");
        }),
      ),
    );
  };
  yield* Effect.sleep("2 seconds").pipe(
    Effect.andThen(
      Effect.gen(function* () {
        const now = nowMs();
        if (now - lastTick > 10000) {
          eligibleAt = now + 45000;
          healthySince = undefined;
        }
        lastTick = now;
        if (disarmed || committed || suspended) return;
        if (observerSequence === 0 && now - startedAt >= 1800000 && status !== "blocked") {
          disarmed = true;
          setStatus("blocked");
          yield* notify;
          return;
        }
        if (now - receivedAt >= 15000) {
          setStatus(
            transportAvailable && now - observedAt < 15000
              ? "suspect"
              : "health-channel-unavailable",
          );
          healthySince = undefined;
        }
        if (healthySince !== undefined && now - healthySince >= 600000) {
          healthySince = undefined;
          yield* options.onSustainedHealth ?? Effect.void;
        }
      }),
    ),
    Effect.forever,
    Effect.forkScoped,
  );
  return {
    read,
    markReady: Effect.sync(() => {
      everReady = true;
    }),
    disarm,
    exitObserved: disarm.pipe(Effect.andThen(Deferred.succeed(exited, undefined))),
    state: Effect.sync(() => status),
  };
});

const RecoveryRecordSchema = Schema.Struct({
  version: Schema.Literal(1),
  attempts: Schema.Array(Schema.Number.check(Schema.isFinite())).check(Schema.isMaxLength(5)),
  attempt: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  lastWallTime: Schema.Number.check(Schema.isFinite()),
  pause: Schema.NullOr(Schema.Literals(["crash-loop", "blocked", "record-unavailable"])),
  generation: Schema.String.check(Schema.isMaxLength(128)),
  outcome: Schema.String.check(Schema.isMaxLength(256)),
});
const encodeRecoveryRecord = Schema.encodeSync(Schema.fromJsonString(RecoveryRecordSchema));
const decodeRecoveryRecord = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RecoveryRecordSchema),
);
class RecoveryRecordOversized extends Schema.TaggedError<RecoveryRecordOversized>()(
  "RecoveryRecordOversized",
  { path: Schema.String },
) {}

export const makeRecoveryBudget = Effect.fn("DesktopBackendWatchdog.makeRecoveryBudget")(
  function* () {
    const fs = yield* FileSystem.FileSystem;
    const lock = yield* Semaphore.make(1);
    let path: string | undefined;
    let record: RecoveryRecord = emptyRecoveryRecord();
    let storageFailed = false;
    const write = Effect.suspend(() => {
      if (path === undefined) return Effect.void;
      const target = path;
      const temporary = `${target}.${NodeCrypto.randomUUID()}.tmp`;
      return fs.makeDirectory(NodePath.dirname(target), { recursive: true, mode: 0o700 }).pipe(
        Effect.andThen(
          fs.writeFileString(temporary, encodeRecoveryRecord(record), { mode: 0o600 }),
        ),
        Effect.andThen(fs.rename(temporary, target)),
        Effect.catchCause(() =>
          Effect.sync(() => {
            storageFailed = true;
            record = { ...record, pause: "record-unavailable" };
          }),
        ),
      );
    });
    const initialize = Effect.fn("DesktopBackendWatchdog.initializeBudget")(
      (nextPath: string | undefined) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            if (path === nextPath || nextPath === undefined) return;
            path = nextPath;
            const loaded = yield* fs.stat(nextPath).pipe(
              Effect.filterOrFail(
                (stat) => stat.size <= 4096,
                () => new RecoveryRecordOversized({ path: nextPath }),
              ),
              Effect.flatMap(() => fs.readFileString(nextPath)),
              Effect.flatMap(decodeRecoveryRecord),
              Effect.catchIf(
                (error) => "reason" in error && error.reason._tag === "NotFound",
                () => Effect.succeed(emptyRecoveryRecord()),
              ),
              Effect.result,
            );
            if (Result.isFailure(loaded)) {
              storageFailed = true;
              record = { ...emptyRecoveryRecord(), pause: "record-unavailable" };
            } else record = loaded.success;
          }),
        ),
    );
    const fail = Effect.fn("DesktopBackendWatchdog.recordFailure")(
      (now: number, generation: string, outcome: string) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            record = recordRestart(record, now, generation, outcome);
            yield* write;
            return record;
          }),
        ),
    );
    const reset = lock.withPermits(1)(
      Effect.gen(function* () {
        record = emptyRecoveryRecord();
        storageFailed = false;
        yield* write;
        return !storageFailed;
      }),
    );
    const pause = Effect.fn("DesktopBackendWatchdog.pause")((reason: "blocked") =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          record = { ...record, pause: reason };
          yield* write;
        }),
      ),
    );
    return { initialize, fail, reset, pause, current: Effect.sync(() => record) };
  },
);
