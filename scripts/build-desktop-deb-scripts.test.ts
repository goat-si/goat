import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { createBuildConfig } from "./build-desktop-artifact.ts";

it.layer(NodeServices.layer)("desktop deb maintainer scripts", (it) => {
  it.effect(
    "deb maintainer scripts keep /usr/bin/t3code pointing at goat-desktop after replacing t3code (#1777)",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const config = yield* createBuildConfig(
          "linux",
          "AppImage",
          "0.1.2-nightly.20261029.300",
          false,
          false,
          undefined,
          undefined,
        );
        const deb = config.deb as { afterInstall?: string; afterRemove?: string };
        // electron-builder's FpmTarget substitutes these macros and rejects any other.
        const render = (template: string) =>
          template.replace(/\$\{([a-zA-Z]+)\}/g, (_, name: string) => {
            const macros: Record<string, string> = {
              executable: "goat-desktop",
              sanitizedProductName: "GOAT (Nightly)",
            };
            if (!(name in macros)) throw new Error(`Macro ${name} is not defined`);
            return macros[name] ?? "";
          });
        assert.isString(deb.afterInstall);
        assert.isString(deb.afterRemove);
        const postinst = render(yield* fs.readFileString(deb.afterInstall ?? ""));
        const postrm = render(yield* fs.readFileString(deb.afterRemove ?? ""));

        assert.include(
          postinst,
          "update-alternatives --install '/usr/bin/t3code' 't3code' '/opt/GOAT (Nightly)/goat-desktop' 100",
        );
        assert.include(
          postrm,
          "update-alternatives --remove 't3code' '/opt/GOAT (Nightly)/goat-desktop'",
        );
        // The electron-builder defaults the templates replace still run.
        assert.include(
          postinst,
          "update-alternatives --install '/usr/bin/goat-desktop' 'goat-desktop' '/opt/GOAT (Nightly)/goat-desktop' 100",
        );
        assert.include(postinst, "chmod 4755 '/opt/GOAT (Nightly)/chrome-sandbox'");
        assert.include(postinst, "update-mime-database /usr/share/mime");
        assert.include(postinst, "update-desktop-database /usr/share/applications");
        assert.include(postinst, "APPARMOR_PROFILE_TARGET='/etc/apparmor.d/goat-desktop'");
        assert.include(
          postrm,
          "update-alternatives --remove 'goat-desktop' '/opt/GOAT (Nightly)/goat-desktop'",
        );
        assert.include(postrm, 'apparmor_parser --remove "$APPARMOR_PROFILE_DEST"');
      }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })))),
  );
});
