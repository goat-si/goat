import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { pinnedRuntimeVersionsDir } from "../cloud/pinnedRuntime.ts";
import * as ServerConfig from "../config.ts";
import { isStrictlyInside, overlaps, type PathRules, samePath } from "./storagePaths.ts";

/**
 * GOAT's own data on this machine, as written and as resolved: folders (state, logs, attachments,
 * runtimes) a removal must not reach into, contain or equal, and GOAT homes it must not equal or
 * contain. A worktrees folder can be set to a GOAT home, so its other children are not leftovers.
 */
export const resolveGoatDataPaths = Effect.fn("storageScan.resolveGoatDataPaths")(function* (
  otherDatabases: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const both = (values: ReadonlyArray<string>) =>
    Effect.forEach(values, (value) => {
      const resolved = path.resolve(value);
      return fs.realPath(resolved).pipe(
        Effect.orElseSucceed(() => resolved),
        Effect.map((real) => (real === resolved ? [resolved] : [resolved, real])),
      );
    }).pipe(Effect.map((lists) => lists.flat()));
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
    homes: yield* both([
      config.baseDir,
      ...otherDatabases.map((database) => path.dirname(path.dirname(database))),
    ]),
  };
});

/** Whether removing target would reach GOAT's own data (see resolveGoatDataPaths). */
export const holdsGoatData = (
  target: string,
  goat: { readonly data: ReadonlyArray<string>; readonly homes: ReadonlyArray<string> },
  rules: PathRules,
) =>
  goat.data.some((folder) => overlaps(folder, target, rules)) ||
  goat.homes.some((home) => samePath(home, target, rules) || isStrictlyInside(target, home, rules));
