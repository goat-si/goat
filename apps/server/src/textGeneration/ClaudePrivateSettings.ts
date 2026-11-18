// @effect-diagnostics-next-line nodeBuiltinImport:off -- The sweep needs lstat and non-recursive removal.
import * as NodeFSP from "node:fs/promises";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import { isProcessAlive } from "../serverRuntimeState.ts";
import {
  CLAUDE_SETTINGS_TEMP_PREFIX,
  claudeSettingsTempOwner,
  TEMP_MIN_AGE_MS,
} from "../storage/storagePaths.ts";

const MAX_VISITS = 1024;
const MAX_REMOVALS = 32;
const SWEEP_INTERVAL_MS = 60_000;
const GENERATED_SUFFIX = /^(?:p[1-9]\d*-)?[a-zA-Z0-9]{6}$/;

export const makeClaudePrivateSettingsSweep = Effect.fn("ClaudePrivateSettings.makeSweep")(
  function* (path: Path.Path, uid: number | undefined) {
    let nextSweep = Number.NEGATIVE_INFINITY;
    let cursor:
      | { readonly root: string; readonly directory: Awaited<ReturnType<typeof NodeFSP.opendir>> }
      | undefined;
    const lock = yield* Semaphore.make(1);
    const close = Effect.fn("ClaudePrivateSettings.closeCursor")(function* () {
      if (cursor === undefined) return;
      const { directory } = cursor;
      cursor = undefined;
      yield* Effect.tryPromise(() => directory.close()).pipe(Effect.ignore);
    }, Effect.uninterruptible);
    yield* Effect.addFinalizer(() => lock.withPermits(1)(close()));

    return Effect.fn("ClaudePrivateSettings.sweep")(
      function* (root: string) {
        const now = yield* Clock.currentTimeMillis;
        if (now < nextSweep) return;
        nextSweep = now + SWEEP_INTERVAL_MS;
        if (cursor?.root !== root) {
          yield* close();
          yield* Effect.tryPromise(() => NodeFSP.opendir(root, { bufferSize: 32 })).pipe(
            Effect.tap((directory) =>
              Effect.sync(() => {
                cursor = { root, directory };
              }),
            ),
            Effect.ignore,
            Effect.uninterruptible,
          );
        }
        const directory = cursor?.directory;
        if (directory === undefined) return;
        let removals = 0;
        for (let visits = 0; visits < MAX_VISITS && removals < MAX_REMOVALS; visits++) {
          const entry = yield* Effect.tryPromise(() => directory.read()).pipe(
            Effect.uninterruptible,
            Effect.orElseSucceed(() => null),
          );
          if (entry === null) {
            yield* close();
            return;
          }
          const name = entry.name;
          if (
            !name.startsWith(CLAUDE_SETTINGS_TEMP_PREFIX) ||
            !GENERATED_SUFFIX.test(name.slice(CLAUDE_SETTINGS_TEMP_PREFIX.length))
          )
            continue;
          const owner = claudeSettingsTempOwner(name);
          if (owner !== undefined && isProcessAlive(owner)) continue;
          const removed = yield* Effect.tryPromise(async () => {
            const directory = path.join(root, name);
            const info = await NodeFSP.lstat(directory);
            if (
              !info.isDirectory() ||
              (uid !== undefined && info.uid !== uid) ||
              now - info.mtimeMs < TEMP_MIN_AGE_MS
            )
              return false;
            const file = path.join(directory, "settings.json");
            const settings = await NodeFSP.lstat(file).catch((cause: unknown) => {
              if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
                return undefined;
              throw cause;
            });
            if (
              settings !== undefined &&
              (!settings.isFile() || (uid !== undefined && settings.uid !== uid))
            )
              return false;
            const current = await NodeFSP.lstat(directory);
            if (
              !current.isDirectory() ||
              current.dev !== info.dev ||
              current.ino !== info.ino ||
              current.mtimeMs !== info.mtimeMs ||
              (owner !== undefined && isProcessAlive(owner))
            )
              return false;
            if (settings !== undefined) await NodeFSP.unlink(file);
            await NodeFSP.rmdir(directory);
            return true;
          }).pipe(Effect.orElseSucceed(() => false));
          if (removed) removals++;
        }
      },
      (effect) => lock.withPermits(1)(effect),
    );
  },
);
