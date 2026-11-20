import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import * as SecretStore from "../auth/ServerSecretStore.ts";
import * as EnvironmentTheme from "../environmentTheme.ts";
import { issueThemeBackgroundUrl, resolveThemeBackgroundAsset } from "./themeBackgroundAsset.ts";

it.layer(NodeServices.layer)("published background hash", (it) => {
  it.effect("refuses changed image bytes even while the published identity remains unchanged", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const base = yield* fs.makeTempDirectoryScoped({ prefix: "goat-theme-hash-" });
        const configLayer = ServerConfig.layerTest(process.cwd(), base);
        const config = yield* ServerConfig.ServerConfig.pipe(Effect.provide(configLayer));
        yield* fs.makeDirectory(path.dirname(config.environmentIdPath), { recursive: true });
        yield* fs.writeFileString(config.environmentIdPath, "hash-env");
        yield* fs.makeDirectory(config.environmentThemesDir, { recursive: true });
        yield* fs.writeFileString(
          path.join(config.environmentThemesDir, "nightfall.json"),
          JSON.stringify({
            name: "Nightfall",
            appearance: "dark",
            canvas: "#112233",
            accent: "#aabbcc",
          }),
        );
        const imagePath = path.join(config.environmentThemesDir, "nightfall.png");
        yield* fs.writeFile(
          imagePath,
          Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]),
        );
        const themes = yield* EnvironmentTheme.readPublishedThemes(config.environmentThemesDir);
        const revision = themes[0]?.background;
        assert.isString(revision);
        const layers = Layer.mergeAll(
          configLayer,
          Layer.mock(SecretStore.ServerSecretStore)({
            getOrCreateRandom: () => Effect.succeed(new Uint8Array(32).fill(7)),
          }),
          Layer.mock(EnvironmentTheme.EnvironmentThemeService)({ current: Effect.succeed(themes) }),
        );
        const minted = yield* issueThemeBackgroundUrl("nightfall", revision!).pipe(
          Effect.provide(layers),
        );
        assert.isNotNull(minted);
        const [, , , token, name] = minted!.relativeUrl.split("/");
        assert.equal(
          (yield* resolveThemeBackgroundAsset(token!, name!).pipe(Effect.provide(layers)))?.kind,
          "found",
        );
        yield* fs.writeFile(
          imagePath,
          Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 1, 1, 1]),
        );
        assert.isNull(
          yield* resolveThemeBackgroundAsset(token!, name!).pipe(Effect.provide(layers)),
        );
      }),
    ),
  );
});
