import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { pinnedRuntimeVersionsDir } from "../cloud/pinnedRuntime.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { managedWorktreesDirectories } from "../worktreesDirectory.ts";
import { isStrictlyInside, overlaps, type PathRules, samePath } from "./storagePaths.ts";

export interface GoatDataPaths {
  /** Folders a removal may not equal, contain or reach into. */
  readonly data: ReadonlyArray<string>;
  /** GOAT homes on this machine: a removal may not equal or contain one. */
  readonly homes: ReadonlyArray<string>;
  /** Worktrees folders: inside a home, only folders within one nested in it can be GOAT's leftovers. */
  readonly worktreeRoots: ReadonlyArray<string>;
}

/**
 * GOAT's own data on this machine, as written and as resolved. A GOAT home holds much besides its
 * worktrees (state, runtimes, notes, caches, tools), and a worktrees folder can be set to a home,
 * so inside any home only what lies in a worktrees folder nested in it is treated as GOAT's
 * leftovers or checkouts.
 */
export const resolveGoatDataPaths = Effect.fn("storage.resolveGoatDataPaths")(function* (
  otherDatabases: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings.pipe(
    Effect.orElseSucceed(() => null),
  );
  const both = (values: ReadonlyArray<string>) =>
    Effect.forEach(values, (value) => {
      const resolved = path.resolve(value);
      return fs.realPath(resolved).pipe(
        Effect.orElseSucceed(() => resolved),
        Effect.map((real) => (real === resolved ? [resolved] : [resolved, real])),
      );
    }).pipe(Effect.map((lists) => lists.flat()));
  const homes = [
    config.baseDir,
    ...otherDatabases.map((database) => path.dirname(path.dirname(database))),
  ];
  return {
    data: yield* both([
      config.stateDir,
      path.dirname(config.dbPath),
      path.dirname(config.settingsPath),
      config.notesDir,
      config.environmentThemesDir,
      config.providerStatusCacheDir,
      config.attachmentsDir,
      config.browserArtifactsDir,
      config.logsDir,
      config.providerLogsDir,
      config.terminalLogsDir,
      config.secretsDir,
      path.dirname(path.dirname(pinnedRuntimeVersionsDir(path, config.baseDir))),
      ...otherDatabases.map((database) => path.dirname(database)),
    ]),
    homes: yield* both(homes),
    worktreeRoots: yield* both([
      ...homes.map((home) => path.join(home, "worktrees")),
      ...(settings === null
        ? []
        : managedWorktreesDirectories(
            settings,
            config.worktreesDir,
            path,
            yield* HostProcess.HomeDirectory,
            yield* HostProcess.Platform,
          )),
    ]),
  } satisfies GoatDataPaths;
});

/** Why removing target would reach GOAT's own data, or null (see resolveGoatDataPaths). */
export const goatDataReason = (target: string, goat: GoatDataPaths, rules: PathRules) => {
  if (goat.data.some((folder) => overlaps(folder, target, rules)))
    return "it holds GOAT's own data";
  for (const home of goat.homes) {
    if (samePath(home, target, rules) || isStrictlyInside(target, home, rules))
      return "it holds a GOAT home";
    if (
      isStrictlyInside(home, target, rules) &&
      !goat.worktreeRoots.some(
        (root) => isStrictlyInside(home, root, rules) && isStrictlyInside(root, target, rules),
      )
    )
      return "it is in a GOAT home outside its worktrees folder";
  }
  return null;
};
