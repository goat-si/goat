import { GOAT_PROJECT_FILE_NAME, type ServerSettings } from "@goat/contracts";
import { LEGACY_PROJECT_FILE_NAME } from "@goat/contracts/legacyT3Names";
import {
  resolveProjectScriptConfiguration,
  resolveProjectSetupScriptConfiguration,
} from "@goat/shared/projectScripts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as GoatProjectFileLoader from "./GoatProjectFileLoader.ts";

export const makeSetupScriptResolver = Effect.gen(function* () {
  const loader = yield* GoatProjectFileLoader.GoatProjectFileLoader;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return Effect.fn("resolveSetupProjectScripts")(function* (
    settings: ServerSettings,
    project: Parameters<typeof resolveProjectScriptConfiguration>[1] & {
      readonly workspaceRoot: string;
    },
    cwd: string,
  ) {
    const { scripts, source } = resolveProjectScriptConfiguration(settings, project);
    if (source !== "unconfigured") return scripts;
    // An invalid branch file must not silently run the root checkout's different command.
    const hasCheckoutFile =
      cwd === project.workspaceRoot ||
      (yield* fs.exists(path.join(cwd, GOAT_PROJECT_FILE_NAME))) ||
      (yield* fs.exists(path.join(cwd, LEGACY_PROJECT_FILE_NAME)));
    const file = yield* loader.load(hasCheckoutFile ? cwd : project.workspaceRoot);
    return resolveProjectSetupScriptConfiguration({ scripts, source }, Option.getOrNull(file))
      .scripts;
  });
});
