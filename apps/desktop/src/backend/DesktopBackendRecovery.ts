// @effect-diagnostics nodeBuiltinImport:off -- Recovery records use atomic filesystem replacement.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import * as FileSystem from "effect/FileSystem";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as Result from "effect/Result";
import * as Effect from "effect/Effect";
import {
  emptyRecoveryRecord,
  recordRestart,
  pruneSlowCrash,
  type RecoveryRecord,
} from "./DesktopBackendRecoveryPolicy.ts";

const RecoveryRecordSchema = Schema.Struct({
  version: Schema.Literal(1),
  attempts: Schema.Array(Schema.Number.check(Schema.isFinite())).check(Schema.isMaxLength(5)),
  attempt: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  lastWallTime: Schema.Number.check(Schema.isFinite()),
  pause: Schema.NullOr(Schema.Literals(["crash-loop", "blocked", "record-unavailable"])),
  generation: Schema.String.check(Schema.isMaxLength(128)),
  outcome: Schema.String.check(Schema.isMaxLength(256)),
  history: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        at: Schema.Number.check(Schema.isFinite()),
        outcome: Schema.String.check(Schema.isMaxLength(64)),
      }),
    ).check(Schema.isMaxLength(8)),
  ),
  notifiedKey: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
});
const encodeRecoveryRecord = Schema.encodeSync(Schema.fromJsonString(RecoveryRecordSchema));
const decodeRecoveryRecord = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RecoveryRecordSchema),
);
class RecoveryRecordOversized extends Schema.TaggedError<RecoveryRecordOversized>()(
  "RecoveryRecordOversized",
  { path: Schema.String },
) {}

export const makeRecoveryBudget = Effect.fn("DesktopBackendRecovery.makeRecoveryBudget")(
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
      let encoded = encodeRecoveryRecord(record);
      while (new TextEncoder().encode(encoded).length > 4096 && (record.history?.length ?? 0) > 0) {
        record = Object.assign({}, record, { history: (record.history ?? []).slice(1) });
        encoded = encodeRecoveryRecord(record);
      }
      while (new TextEncoder().encode(encoded).length > 4096 && record.outcome.length > 0) {
        record = {
          ...record,
          outcome: record.outcome.slice(0, Math.floor(record.outcome.length / 2)),
        };
        encoded = encodeRecoveryRecord(record);
      }
      return fs.makeDirectory(NodePath.dirname(target), { recursive: true, mode: 0o700 }).pipe(
        Effect.andThen(fs.writeFileString(temporary, encoded, { mode: 0o600 })),
        Effect.andThen(fs.rename(temporary, target)),
        Effect.catchCause(() =>
          Effect.sync(() => {
            storageFailed = true;
            record = { ...record, pause: "record-unavailable" };
          }),
        ),
      );
    });
    const initialize = Effect.fn("DesktopBackendRecovery.initializeBudget")(
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
    const fail = Effect.fn("DesktopBackendRecovery.recordFailure")(
      (now: number, generation: string, outcome: string) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const previous = pruneSlowCrash(record, now);
            record = recordRestart(record, now, generation, outcome);
            const notify =
              record.notifiedKey !== undefined && record.notifiedKey !== previous.notifiedKey;
            yield* write;
            return { record, notify };
          }),
        ),
    );
    const reset = lock.withPermits(1)(
      Effect.gen(function* () {
        const { history, notifiedKey } = record;
        record = {
          ...emptyRecoveryRecord(),
          ...(history === undefined ? {} : { history }),
          ...(notifiedKey === undefined ? {} : { notifiedKey }),
        };
        storageFailed = false;
        yield* write;
        return !storageFailed;
      }),
    );
    const pause = Effect.fn("DesktopBackendRecovery.pause")((reason: "blocked") =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          record = { ...record, pause: reason };
          yield* write;
        }),
      ),
    );
    const currentAt = Effect.fn("DesktopBackendRecovery.currentAt")((now: number) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const next = pruneSlowCrash(record, now);
          if (
            next.notifiedKey !== record.notifiedKey ||
            next.history?.length !== record.history?.length
          ) {
            record = next;
            yield* write;
          }
          return record;
        }),
      ),
    );
    return { initialize, fail, reset, pause, currentAt, current: Effect.sync(() => record) };
  },
);
