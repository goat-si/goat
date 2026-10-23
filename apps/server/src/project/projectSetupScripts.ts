import { GOAT_PROJECT_FILE_NAME, type ProjectScript, type ServerSettings } from "@goat/contracts";
import { LEGACY_PROJECT_FILE_NAME } from "@goat/contracts/legacyT3Names";
import { resolveProjectScripts, setupProjectScript } from "@goat/shared/projectScripts";
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
    project: Parameters<typeof resolveProjectScripts>[1] & { readonly workspaceRoot: string },
    cwd: string,
  ) {
    const scripts = resolveProjectScripts(settings, project);
    if (setupProjectScript(scripts) !== null) return scripts;
    // An invalid branch file must not silently run the root checkout's different command.
    const hasCheckoutFile =
      cwd === project.workspaceRoot ||
      (yield* fs.exists(path.join(cwd, GOAT_PROJECT_FILE_NAME))) ||
      (yield* fs.exists(path.join(cwd, LEGACY_PROJECT_FILE_NAME)));
    const file = yield* loader.load(hasCheckoutFile ? cwd : project.workspaceRoot);
    const declared = Option.getOrNull(file)?.scripts?.find((script) => script.runOnWorktreeCreate);
    if (declared === undefined) return scripts;
    let id = "goat-file-setup";
    for (let suffix = 2; scripts.some((script) => script.id === id); suffix++) {
      id = `goat-file-setup-${suffix}`;
    }
    return [
      ...scripts,
      {
        ...declared,
        id,
        icon: declared.icon ?? "play",
        runOnWorktreeCreate: true,
      } satisfies ProjectScript,
    ];
  });
});
