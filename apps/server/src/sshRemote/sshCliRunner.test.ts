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
