import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import * as ServerConfig from "../config.ts";
import * as SecretStore from "../auth/ServerSecretStore.ts";
import { readPublishedThemes, layer as environmentThemeLayer } from "../environmentTheme.ts";
import { issueThemeBackgroundUrl, resolveThemeBackgroundAsset } from "./themeBackgroundAsset.ts";
import { openAssetClaims, sealAssetClaims } from "./assetClaimsSeal.ts";
import { fromSecret } from "../auth/PayloadSigner.ts";

it.layer(NodeServices.layer)("published background assets", (it) => {
  it.effect("binds the signature to environment, published identity, bytes and expiry", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseA = yield* fs.makeTempDirectoryScoped({ prefix: "goat-theme-a-" });
        const baseB = yield* fs.makeTempDirectoryScoped({ prefix: "goat-theme-b-" });
        const secret = Layer.mock(SecretStore.ServerSecretStore)({
          getOrCreateRandom: () => Effect.succeed(new Uint8Array(32).fill(7)),
        });
        const configA = ServerConfig.layerTest(process.cwd(), baseA);
        const configB = ServerConfig.layerTest(process.cwd(), baseB);
        const themeLayer = environmentThemeLayer.pipe(Layer.provide(configA));
        const themeLayerB = environmentThemeLayer.pipe(Layer.provide(configB));
        const initialize = (label: string) =>
          Effect.gen(function* () {
            const config = yield* ServerConfig.ServerConfig;
            yield* fs.makeDirectory(path.dirname(config.environmentIdPath), { recursive: true });
            yield* fs.writeFileString(config.environmentIdPath, label);
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
            yield* fs.writeFile(
              path.join(config.environmentThemesDir, "nightfall.png"),
              Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]),
            );
          });
        yield* initialize("env-a").pipe(Effect.provide(configA));
        yield* initialize("env-b").pipe(Effect.provide(configB));
        const config = yield* ServerConfig.ServerConfig.pipe(Effect.provide(configA));
        const themes = yield* readPublishedThemes(config.environmentThemesDir);
        const revision = themes[0]?.background;
        assert.isString(revision);
        const minted = yield* issueThemeBackgroundUrl("nightfall", revision!).pipe(
          Effect.provide(Layer.mergeAll(configA, secret, themeLayer)),
        );
        assert.isNotNull(minted);
        assert.isNull(
          yield* issueThemeBackgroundUrl("../nightfall", revision!).pipe(
            Effect.provide(Layer.mergeAll(configA, secret, themeLayer)),
          ),
        );
        const parts = minted!.relativeUrl.split("/");
        const token = parts[3]!;
        const name = parts[4]!;
        const resolved = (candidate: string, file: string, configLayer = configA) =>
          resolveThemeBackgroundAsset(candidate, file).pipe(
            Effect.provide(
              Layer.mergeAll(
                configLayer,
                secret,
                configLayer === configA ? themeLayer : themeLayerB,
              ),
            ),
          );
        const valid = yield* resolved(token, name);
        assert.equal(valid?.kind, "found");
        if (valid?.kind !== "found") throw new Error("Expected verified background bytes");
        assert.deepEqual(Array.from(valid.bytes), [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
        assert.isNull(yield* resolved(`${token}x`, name));
        const secretBytes = new Uint8Array(32).fill(7);
        const payload = token.slice("tb1-".length).split(".")[0]!;
        const claims = JSON.parse(openAssetClaims(payload, secretBytes)!);
        claims.revision = `png:${"0".repeat(64)}`;
        const tamperedPayload = sealAssetClaims(JSON.stringify(claims), secretBytes);
        const tamperedToken = `tb1-${tamperedPayload}.${fromSecret(secretBytes).sign(tamperedPayload)}`;
        assert.isNull(yield* resolved(tamperedToken, name));
        assert.isNull(yield* resolved(token, "../background"));
        assert.isNull(yield* resolved(token, name, configB));
        yield* TestClock.adjust("2 hours");
        assert.isNull(yield* resolved(token, name));
        const fresh = yield* issueThemeBackgroundUrl("nightfall", revision!).pipe(
          Effect.provide(Layer.mergeAll(configA, secret, themeLayer)),
        );
        const freshToken = fresh!.relativeUrl.split("/")[3]!;
        const themePath = path.join(config.environmentThemesDir, "nightfall.json");
        const originalTheme = yield* fs.readFileString(themePath);
        yield* fs.writeFileString(
          themePath,
          JSON.stringify({
            name: "Republished",
            appearance: "dark",
            canvas: "#112233",
            accent: "#aabbcc",
          }),
        );
        assert.isNull(yield* resolved(freshToken, name));
        yield* fs.writeFileString(themePath, originalTheme);
        yield* fs.writeFile(
          path.join(config.environmentThemesDir, "nightfall.png"),
          Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 1, 1, 1]),
        );
        assert.isNull(yield* resolved(freshToken, name));
        yield* fs.writeFile(
          path.join(config.environmentThemesDir, "nightfall.png"),
          Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]),
        );
        yield* fs.remove(path.join(config.environmentThemesDir, "nightfall.json"));
        assert.isNull(yield* resolved(freshToken, name));
      }),
    ),
  );
});
