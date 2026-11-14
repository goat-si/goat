// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@goat/provider-core/server/ProviderEventLoggers";
import * as ProviderLatestVersions from "@goat/provider-core/server/ProviderLatestVersions";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient } from "effect/http";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as MemoryDerivedCache from "../../memory/MemoryDerivedCache.ts";
import * as CodexAdapterV2 from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as CodexInstallation from "../CodexInstallation.ts";
import * as CodexManagedTokenBroker from "../CodexManagedTokenBroker.ts";
import * as ModelManifest from "../ModelManifest.ts";
import * as ProviderHostLive from "../ProviderHostLive.ts";
import * as ResetCreditCoordinator from "../resetCreditCoordinator.ts";

const layerDeps = ServerConfig.layerTest(process.cwd(), {
  prefix: "goat-codex-driver-maintenance-",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(Layer.succeed(HostProcess.Environment, { PATH: "" })),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(McpProviderSessions.layer),
  Layer.provideMerge(
    Layer.mock(CodexAdapterV2.CodexAppServerClientFactory)({
      open: () => Effect.die("Maintenance resolution must not open a Codex session"),
    }),
  ),
  Layer.provideMerge(
    Layer.mock(CodexInstallation.CodexInstallation)({
      managedDirectory: "unused-managed-installation",
    }),
  ),
  Layer.provideMerge(Layer.mock(ServerSecretStore.ServerSecretStore)({})),
  Layer.provideMerge(
    Layer.mock(CodexManagedTokenBroker.CodexManagedTokenBroker)({
      endpoint: Effect.succeed("unused-private-pipe"),
      awaitIdle: Effect.void,
    }),
  ),
  Layer.provideMerge(
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("00000000-0000-4000-8000-000000000001")),
    }),
  ),
  Layer.provideMerge(MemoryDerivedCache.layer),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(ModelManifest.layerTest),
  Layer.provideMerge(ResetCreditCoordinator.layerTest),
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
  Layer.provideMerge(ProviderLatestVersions.layer),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Disabled Codex must not make an HTTP request")),
    ),
  ),
);
export const layerTest = ProviderHostLive.layer.pipe(Layer.provideMerge(layerDeps));
