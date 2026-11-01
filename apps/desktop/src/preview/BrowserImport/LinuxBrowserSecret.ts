import { LEGACY_BROWSER_SECRET_BINARY_NAME } from "@goat/contracts/legacyT3Names";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";

export const LinuxBrowserSecretPath = Context.Reference<string | undefined>(
  "@goat/desktop/preview/BrowserImport/LinuxBrowserSecretPath",
  { defaultValue: () => undefined },
);

export const layer = Layer.effect(
  LinuxBrowserSecretPath,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    if (environment.platform !== "linux") return undefined;
    const fileSystem = yield* FileSystem.FileSystem;
    const candidates = ["goat-browser-secret", LEGACY_BROWSER_SECRET_BINARY_NAME].flatMap(
      (binaryName) => {
        const relative = environment.path.join("browser-secret", binaryName);
        return environment.isPackaged
          ? [environment.path.join(environment.resourcesPath, relative)]
          : [
              environment.path.join(
                environment.rootDir,
                "native",
                "browser-secret",
                "build",
                environment.processArch,
                binaryName,
              ),
              ...environment.resolveResourcePathCandidates(relative),
            ];
      },
    );
    for (const candidate of candidates) {
      if (yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false)))
        return candidate;
    }
    return undefined;
  }),
);
