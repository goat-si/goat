import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, type ProviderInstanceConfigMap } from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../../config.ts";
import * as MemoryDerivedCache from "../../memory/MemoryDerivedCache.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
import { makeReplayServerConfig } from "./CodexAdapterV2.testkit.ts";

const instanceId = ProviderInstanceId.make("codex");

/** The settings key of a Codex instance built by its driver from `config`. */
const sessionConfigKey = (config: Record<string, unknown>) =>
  Effect.gen(function* () {
    const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
    return (yield* registry.get(instanceId)).sessionConfigKey;
  }).pipe(
    Effect.provide(
      ProviderAdapterRegistry.layerFromDrivers({
        drivers: [CodexAdapterV2.CodexAdapterV2Driver],
        configMap: {
          [instanceId]: { driver: CodexAdapterV2.CODEX_DRIVER_KIND, config },
        } as ProviderInstanceConfigMap,
      }).pipe(
        Layer.provide(
          Layer.mergeAll(
            MemoryDerivedCache.layer,
            Layer.succeed(CodexAdapterV2.CodexAppServerClientFactory, {
              open: () => Effect.die("unused"),
            }),
            Layer.effect(
              ServerConfig.ServerConfig,
              makeReplayServerConfig("codex-session-key").pipe(Effect.orDie),
            ),
            IdAllocator.layer,
            McpProviderSessions.layer,
          ),
        ),
        Layer.provide(NodeServices.layer),
      ),
    ),
  );

it.effect("a CODEX_HOME change under a shadow home gives Codex a new settings key", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped();
    const shadowHomePath = path.join(root, "shadow");
    const homes = [path.join(root, "home-a"), path.join(root, "home-b")];
    for (const home of homes) yield* fileSystem.makeDirectory(home, { recursive: true });

    const keys = [];
    for (const homePath of homes) keys.push(yield* sessionConfigKey({ homePath, shadowHomePath }));
    assert.isDefined(keys[0]);
    assert.notStrictEqual(keys[0], keys[1]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
