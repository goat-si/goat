import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@goat/provider-core/server/ProviderEventLoggers";
import * as ProviderLatestVersions from "@goat/provider-core/server/ProviderLatestVersions";
import * as Config from "../../config.ts";
import * as Settings from "../../serverSettings.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as MemoryDerivedCache from "../../memory/MemoryDerivedCache.ts";
import * as Factory from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Environment from "../../environment/ServerEnvironment.ts";
import * as TokenBroker from "../CodexManagedTokenBroker.ts";
import * as Secrets from "../../auth/ServerSecretStore.ts";
import * as Installation from "../CodexInstallation.ts";
import * as Host from "../ProviderHostLive.ts";
import * as ModelManifest from "../ModelManifest.ts";
import * as ResetCredit from "../resetCreditCoordinator.ts";
import { CodexDriver } from "./CodexDriver.ts";
const dependencies = Config.layerTest(process.cwd(), { prefix: "codex-home-driver-" }).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      NodeServices.layer,
      IdAllocator.layer,
      McpProviderSessions.layer,
      MemoryDerivedCache.layer,
      Settings.layerTest(),
      ModelManifest.layerTest,
      ResetCredit.layerTest,
      ProviderLatestVersions.layer,
    ),
  ),
  Layer.provideMerge(
    Layer.mock(Factory.CodexAppServerClientFactory)({
      open: () => Effect.die("Disabled instances do not launch"),
    }),
  ),
  Layer.provideMerge(Layer.mock(Installation.CodexInstallation)({ managedDirectory: "unused" })),
  Layer.provideMerge(Layer.mock(Secrets.ServerSecretStore)({})),
  Layer.provideMerge(
    Layer.mock(TokenBroker.CodexManagedTokenBroker)({
      endpoint: Effect.succeed("unused-private-pipe"),
      awaitIdle: Effect.void,
    }),
  ),
  Layer.provideMerge(
    Layer.succeed(Environment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("test-home")),
    }),
  ),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
  Layer.provideMerge(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("No HTTP for disabled instances")),
    ),
  ),
);
it.effect(
  "does not expose reset credit redemption for a Home route and preserves continuation identity for the same home",
  () =>
    Effect.gen(function* () {
      const config = { ...CodexDriver.defaultConfig(), homePath: "/same-codex-home" };
      const own = yield* CodexDriver.create({
        instanceId: ProviderInstanceId.make("codex-own"),
        displayName: "Own account",
        environment: [],
        enabled: false,
        config,
      });
      const home = yield* CodexDriver.create({
        instanceId: ProviderInstanceId.make("codex-home"),
        displayName: "Home",
        environment: [],
        enabled: false,
        config: { ...config, modelRoute: "opencodex" },
      });
      assert.isDefined(own.consumeResetCredit);
      assert.isUndefined(home.consumeResetCredit);
      assert.deepStrictEqual(home.continuationIdentity, own.continuationIdentity);
    }).pipe(
      Effect.provide(Host.layer.pipe(Layer.provideMerge(dependencies))),
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => Effect.die("No provider process should launch")),
      ),
    ),
);
