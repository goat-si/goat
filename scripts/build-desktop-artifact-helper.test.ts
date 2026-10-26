import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import { createBuildConfig, DESKTOP_EXTRA_RESOURCES } from "./build-desktop-artifact.ts";

it.effect("places the signed Nightly computer use helper under Contents/Helpers", () =>
  Effect.gen(function* () {
    const config = yield* createBuildConfig(
      "mac",
      "dmg",
      "1.2.3-nightly.20261024.1",
      true,
      false,
      undefined,
      undefined,
      false,
      undefined,
      false,
      "/tmp/goat-computer-use/GOAT Computer Use.app",
    );
    assert.deepStrictEqual(config.extraResources, [
      ...DESKTOP_EXTRA_RESOURCES.filter((resource) => resource.to !== "cua-driver"),
      {
        from: "/tmp/goat-computer-use/GOAT Computer Use.app",
        to: "../Helpers/GOAT Computer Use.app",
      },
    ]);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(NodeServices.layer, ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
    ),
  ),
);
