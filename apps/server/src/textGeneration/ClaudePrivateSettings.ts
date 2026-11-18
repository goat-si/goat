// @effect-diagnostics-next-line nodeBuiltinImport:off -- The sweep needs lstat and non-recursive removal.
import * as NodeFSP from "node:fs/promises";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type * as Path from "effect/Path";
import { isProcessAlive } from "../serverRuntimeState.ts";
import { listClaudeDiscoveryDirectory } from "../provider/claudeDiscoveryBudget.ts";
import {
  CLAUDE_SETTINGS_TEMP_PREFIX,
  claudeSettingsTempOwner,
  TEMP_MIN_AGE_MS,
} from "../storage/storagePaths.ts";

const MAX_VISITS = 1024;
const MAX_REMOVALS = 32;
const SWEEP_INTERVAL_MS = 60_000;
const GENERATED_SUFFIX = /^(?:p[1-9]\d*-)?[a-zA-Z0-9]{6}$/;

export function makeClaudePrivateSettingsSweep(path: Path.Path, uid: number | undefined) {
  let nextSweep = Number.NEGATIVE_INFINITY;
  return Effect.fn("ClaudePrivateSettings.sweep")(function* (root: string) {
    const now = yield* Clock.currentTimeMillis;
    if (now < nextSweep) return;
    nextSweep = now + SWEEP_INTERVAL_MS;

    let removals = 0;
    for (const name of yield* listClaudeDiscoveryDirectory(root, MAX_VISITS)) {
      if (removals >= MAX_REMOVALS) break;
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
  });
}
