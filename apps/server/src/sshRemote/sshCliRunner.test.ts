import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import { assert, it } from "@effect/vitest";

import packageJson from "../../package.json" with { type: "json" };
import { resolveSshCliRunner } from "./sshCliRunner.ts";

it.effect("the server runner names its own build as its own runtime version", () =>
  Effect.gen(function* () {
    const runner = yield* resolveSshCliRunner("/fixture/home").pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord({})),
    );
    assert.equal(runner.ownRuntimeVersion, packageJson.version);
    assert.equal(runner.archiveVersion, packageJson.version);
  }),
);

it.effect("uses the serving client's own assets only for bundled SSH archives", () =>
  Effect.gen(function* () {
    for (const bundled of [false, true]) {
      const environment = bundled
        ? { GOAT_SSH_BUNDLED_RUNTIME_ARCHIVE_DIR: "/fixture/bundle" }
        : {};
      const runner = yield* resolveSshCliRunner("/fixture/home", "/fixture/client").pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnvRecord(environment),
        ),
      );
      assert.equal(
        runner.bundledFontAssetDirectory,
        bundled ? "/fixture/client/assets" : undefined,
      );
    }
  }),
);
