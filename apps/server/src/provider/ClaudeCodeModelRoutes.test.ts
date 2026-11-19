import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { vi } from "vite-plus/test";
import { assert, describe, it } from "@effect/vitest";
import { type ModelSelection, ProviderInstanceId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import {
  makeClaudeCodeModelRoutes,
  resolveClaudeModelSettingsKey,
} from "./ClaudeCodeModelRoutes.ts";
import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  resolveClaudeCatalogApiModelId,
} from "./ClaudeModelCatalog.ts";

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>()),
  resolveSettings: () => Promise.resolve({ effective: {}, provenance: {}, sources: [] }),
}));

describe("Claude Code model routes", () => {
  it.effect("keeps reported routes scoped to the custom Claude home's model settings", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const file = path.join(home, "settings.json");
      const environment = { CLAUDE_CONFIG_DIR: home };
      const catalog = BUNDLED_CLAUDE_MODEL_CATALOG;
      const routes = yield* makeClaudeCodeModelRoutes(
        (cwd, env) =>
          resolveClaudeModelSettingsKey([], cwd, env).pipe(
            Effect.provideService(Path.Path, path),
            Effect.provideService(FileSystem.FileSystem, fs),
          ),
        home,
      );
      yield* fs.writeFileString(file, '{"env":{"ANTHROPIC_DEFAULT_HAIKU_MODEL":"backend-a"}}');
      yield* routes.record(
        [{ value: "haiku", resolvedModel: "us.anthropic.claude-haiku-4-5-20251001-v1:0" }],
        environment,
      );
      yield* routes.settle;
      assert.notStrictEqual(yield* routes.route(catalog, null, undefined, environment), catalog);
      yield* fs.writeFileString(file, '{"env":{"ANTHROPIC_DEFAULT_HAIKU_MODEL":"backend-b"}}');
      assert.strictEqual(yield* routes.route(catalog, null, undefined, environment), catalog);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("uses reported routes only under the probe's workspace and environment settings", () =>
    Effect.gen(function* () {
      const routes = yield* makeClaudeCodeModelRoutes(
        (cwd, environment) =>
          Effect.succeed(
            cwd === "/different-project" ? "local override" : environment?.CLAUDE_CODE_USE_BEDROCK,
          ),
        "/state",
      );
      const bedrock = { CLAUDE_CODE_USE_BEDROCK: "1" };
      const selection = {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-haiku-4-5",
      };
      yield* routes.record(
        [{ value: "haiku", resolvedModel: "us.anthropic.claude-haiku-4-5-20251001-v1:0" }],
        bedrock,
      );
      yield* routes.settle;
      const catalog = BUNDLED_CLAUDE_MODEL_CATALOG;
      const same = yield* routes.route(catalog, "/workspace", undefined, bedrock);
      assert.equal(resolveClaudeCatalogApiModelId(same, selection), "haiku");
      assert.strictEqual(
        yield* routes.route(catalog, "/different-project", undefined, bedrock),
        catalog,
      );
      assert.strictEqual(yield* routes.route(catalog, "/workspace", undefined, {}), catalog);
      assert.strictEqual(
        yield* routes.route(catalog, "/workspace", { env: { ANTHROPIC_MODEL: "other" } }, bedrock),
        catalog,
      );
    }),
  );

  it.effect(
    "a turn that starts before the first probe settles waits and then gets its routes",
    () =>
      Effect.gen(function* () {
        const haiku = {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-haiku-4-5",
        } satisfies ModelSelection;
        const routes = yield* makeClaudeCodeModelRoutes(
          () => Effect.succeed("same settings"),
          "/state",
        );
        const early = yield* routes
          .route(BUNDLED_CLAUDE_MODEL_CATALOG, "/project")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* routes.record([
          { value: "haiku", resolvedModel: "us.anthropic.claude-haiku-4-5-20251001-v1:0" },
        ]);
        yield* routes.settle;
        assert.strictEqual(
          resolveClaudeCatalogApiModelId(yield* Fiber.join(early), haiku),
          "haiku",
        );

        // A first check that never reaches the probe still releases waiting turns.
        const unprobed = yield* makeClaudeCodeModelRoutes(
          () => Effect.succeed("same settings"),
          "/state",
        );
        const waiting = yield* unprobed
          .route(BUNDLED_CLAUDE_MODEL_CATALOG, "/project")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* unprobed.settle;
        assert.strictEqual(yield* Fiber.join(waiting), BUNDLED_CLAUDE_MODEL_CATALOG);

        const stuck = yield* makeClaudeCodeModelRoutes(
          () => Effect.succeed("same settings"),
          "/state",
        );
        const fallback = yield* stuck
          .route(BUNDLED_CLAUDE_MODEL_CATALOG, "/project")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* TestClock.adjust("2 minutes");
        assert.strictEqual(yield* Fiber.join(fallback), BUNDLED_CLAUDE_MODEL_CATALOG);
        // Later turns, steers and effort changes do not wait for the stuck probe again.
        const later = yield* stuck
          .route(BUNDLED_CLAUDE_MODEL_CATALOG, "/project")
          .pipe(Effect.timeoutOption("1 second"), Effect.forkChild({ startImmediately: true }));
        yield* TestClock.adjust("1 second");
        assert.deepStrictEqual(yield* Fiber.join(later), Option.some(BUNDLED_CLAUDE_MODEL_CATALOG));
      }),
  );
});
