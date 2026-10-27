// @effect-diagnostics nodeBuiltinImport:off - Effect has no random token.
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";
import { isProcessAlive } from "../serverRuntimeState.ts";

const LOCK = ".install-lock";
const TOMBSTONE = `${LOCK}.stale-`;
const Owner = Schema.Struct({
  pid: Schema.Int,
  /** The OS start time of `pid`; with the pid it names one process even after pid reuse. */
  startTime: Schema.NullOr(Schema.String),
  nonce: Schema.String,
});
type Owner = typeof Owner.Type;
const decodeOwner = Schema.decodeUnknownOption(Schema.fromJsonString(Owner));
const encodeOwner = Schema.encodeSync(Schema.fromJsonString(Owner));

const alreadyExists = (error: PlatformError.PlatformError) => error.reason._tag === "AlreadyExists";
const notFound = (error: PlatformError.PlatformError) => error.reason._tag === "NotFound";

/**
 * One installer per machine: an exclusive lock file names its owner process by pid, start time
 * and nonce. A record whose owner is gone is moved to a tombstone and checked again, so a new
 * owner that won the race keeps its lock; a crash leaves at most a tombstone, which is ignored.
 */
export const makeInstallLock = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;

  const startTime = Effect.fn("OpenCodexInstallLock.startTime")(function* (pid: number) {
    // Linux: field 22 of /proc/<pid>/stat, counted after the parenthesized command name.
    const stat = yield* fs.readFileString(`/proc/${pid}/stat`).pipe(Effect.option);
    if (Option.isSome(stat))
      return stat.value.slice(stat.value.lastIndexOf(")") + 2).split(" ")[19] || undefined;
    const output = yield* runner
      .run({
        command: "ps",
        args: ["-o", "lstart=", "-p", String(pid)],
        timeout: "10 seconds",
        timeoutBehavior: "timedOutResult",
      })
      .pipe(Effect.option);
    const text = Option.isSome(output) && output.value.code === 0 ? output.value.stdout.trim() : "";
    return text === "" ? undefined : text;
  });
  const ownStart = yield* Effect.cached(startTime(process.pid));
  /** Live unless the pid is gone or now names a process started at another time. */
  const live = Effect.fn("OpenCodexInstallLock.live")(function* (owner: Owner) {
    if (!isProcessAlive(owner.pid)) return false;
    if (owner.startTime === null) return true;
    const now = yield* startTime(owner.pid);
    return now === undefined || now === owner.startTime;
  });
  const readOwner = (file: string) =>
    fs.readFileString(file).pipe(Effect.map((text) => ({ text, owner: decodeOwner(text) })));

  /** Tombstones and staged records of owners that are gone; a live one may still be in use. */
  const sweep = Effect.fn("OpenCodexInstallLock.sweep")(function* (prefix: string) {
    for (const name of yield* fs.readDirectory(prefix)) {
      if (!name.startsWith(TOMBSTONE) && !(name.startsWith(`${LOCK}.`) && name.endsWith(".tmp")))
        continue;
      const file = path.join(prefix, name);
      const found = yield* readOwner(file).pipe(Effect.option);
      const owner = Option.flatMap(found, (read) => read.owner);
      if (Option.isSome(owner) && (yield* live(owner.value))) continue;
      yield* fs.remove(file).pipe(Effect.ignore);
    }
  });

  /** Holds the lock for the enclosing scope, or fails with `busy`. */
  const acquire = Effect.fn("OpenCodexInstallLock.acquire")(function* <E>(
    prefix: string,
    busy: () => E,
  ) {
    const lockPath = path.join(prefix, LOCK);
    const nonce = NodeCrypto.randomUUID();
    const mine = encodeOwner({ pid: process.pid, startTime: (yield* ownStart) ?? null, nonce });
    // Written whole first, then linked: the lock path never names a partial record.
    const publish = Effect.gen(function* () {
      const staged = path.join(prefix, `${LOCK}.${nonce}.tmp`);
      yield* fs.writeFileString(staged, mine, { flag: "wx", mode: 0o600 });
      const linked = yield* fs.link(staged, lockPath).pipe(
        Effect.as(true),
        Effect.catchIf(alreadyExists, () => Effect.succeed(false)),
      );
      yield* fs.remove(staged);
      return linked;
    });
    const take = Effect.gen(function* () {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (yield* publish) return;
        const seen = yield* readOwner(lockPath).pipe(Effect.option);
        if (Option.isNone(seen)) continue;
        if (Option.isSome(seen.value.owner) && (yield* live(seen.value.owner.value)))
          return yield* Effect.fail(busy());
        const tombstone = `${lockPath}.stale-${nonce}`;
        const moved = yield* fs.rename(lockPath, tombstone).pipe(
          Effect.as(true),
          Effect.catchIf(notFound, () => Effect.succeed(false)),
        );
        if (!moved) continue;
        const taken = yield* fs.readFileString(tombstone).pipe(Effect.option);
        if (Option.isSome(taken) && taken.value === seen.value.text) {
          yield* fs.remove(tombstone);
          continue;
        }
        // A new owner took the lock after the stale read: put its record back, never over another.
        const restored = yield* fs.link(tombstone, lockPath).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
        if (restored) yield* fs.remove(tombstone).pipe(Effect.ignore);
        return yield* Effect.fail(busy());
      }
      return yield* Effect.fail(busy());
    });
    const release = readOwner(lockPath).pipe(
      Effect.flatMap(({ owner }) =>
        Option.isSome(owner) && owner.value.nonce === nonce ? fs.remove(lockPath) : Effect.void,
      ),
      Effect.ignore,
    );
    yield* Effect.acquireRelease(take, () => release);
    yield* sweep(prefix).pipe(Effect.ignore);
  });

  return { acquire };
});
