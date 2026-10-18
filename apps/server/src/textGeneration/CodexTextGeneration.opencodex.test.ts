import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CodexSettings, ProviderInstanceId } from "@goat/contracts";
import { createModelSelection } from "@goat/shared/model";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Config from "../config.ts";
import * as HomeRoute from "../provider/OpenCodexRoute.ts";
import { makeCodexTextGeneration } from "./CodexTextGeneration.ts";
const decode = Schema.decodeSync(CodexSettings);
it.effect(
  "refuses exec without a version-specific precedence proof and never retries through default Codex",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "codex-home-exec-" });
      const observations: HomeRoute.RouteInput[] = [];
      let launches = 0;
      const routes = HomeRoute.OpenCodexRoute.of({
        inspect: () => Effect.die("unused"),
        requireAvailable: (input) =>
          Effect.sync(() => {
            observations.push(input);
          }),
        launchArgs: () =>
          Effect.succeed([
            "-c",
            'model_provider="openai"',
            "-c",
            'openai_base_url="http://127.0.0.1:10100/v1"',
            "-c",
            `model_catalog_json="${home}/opencodex-catalog.json"`,
          ]),
      });
      const generation = yield* makeCodexTextGeneration(
        decode({ modelRoute: "opencodex", homePath: home, launchArgs: "--profile work" }),
        { GOAT_CODEX_LAUNCH_ARGS: "--profile environment" },
      ).pipe(
        Effect.provideService(HomeRoute.OpenCodexRoute, routes),
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => {
            launches++;
            return Effect.die("No unverified exec may run");
          }),
        ),
      );
      const result = yield* generation
        .generateThreadTitle({
          cwd: home,
          message: "Summarize this work",
          modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "home-model"),
        })
        .pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure")
        assert.include(result.failure.message, "Could not verify the effective Codex endpoint.");
      assert.equal(launches, 0);
      assert.equal(observations.length, 1);
      assert.equal(observations[0]?.execution.home, home);
      assert.equal(observations[0]?.execution.cwd, home);
      assert.equal(
        observations[0]?.execution.environment.OPENAI_BASE_URL,
        "http://127.0.0.1:10100/v1",
      );
      assert.deepStrictEqual(observations[0]?.execution.configArgv, ["--profile", "environment"]);
    }).pipe(
      Effect.provide(
        Config.layerTest(process.cwd(), { prefix: "codex-home-exec-test-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
);
