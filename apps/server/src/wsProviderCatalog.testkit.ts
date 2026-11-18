import {
  AuthOrchestrationReadScope,
  AuthSessionId,
  RpcScopeAuthorization,
  WsSubscribeServerConfigRpc,
  WsServerRefreshProvidersRpc,
  type AuthEnvironmentScope,
  type ServerProvider,
} from "@goat/contracts";
import type { ProviderInstance } from "@goat/provider-core/server/driver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { RpcGroup, RpcTest } from "effect/rpc";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as RpcAuthorization from "./auth/RpcAuthorization.ts";
import * as DirectEndpoints from "./environment/DirectEndpoints.ts";
import * as RemoteOpenTargets from "./environment/RemoteOpenTargets.ts";
import * as PreviewAutomationBroker from "./mcp/PreviewAutomationBroker.ts";
import * as ServerBrowser from "./preview/ServerBrowser.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as ManagedProjectFolders from "./project/ManagedProjectFolders.ts";
import * as ProjectService from "./project/ProjectService.ts";
import * as ScratchThreadPromotion from "./project/ScratchThreadPromotion.ts";
import * as ProviderInstanceRegistry from "./provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "./provider/ProviderRegistry.ts";
import * as UsageLimitSources from "./usage/UsageLimitSources.ts";
import { layerWsRpc } from "./ws.ts";
import {
  layerConfigEnvironment,
  layerConfigSources,
  layerUnusedConfigRpcServices,
} from "./wsRpcServices.testkit.ts";

export function makeProviderCatalogRpc(options: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly cwdProviders: ReadonlySet<string>;
  readonly scopes?: ReadonlyArray<AuthEnvironmentScope>;
  readonly recordRefresh?: () => void;
  readonly providerChanges?: Stream.Stream<ReadonlyArray<ServerProvider>>;
  readonly projectProviders?: UsageLimitSources.UsageLimitSources["Service"]["projectProviders"];
}) {
  const scopes = options.scopes ?? [AuthOrchestrationReadScope];
  const providers = Effect.succeed(options.providers);
  const instances = options.providers.map(
    (provider) =>
      ({
        instanceId: provider.instanceId,
        ...(options.cwdProviders.has(provider.instanceId)
          ? { snapshotForCwd: () => Effect.die("unexpected provider scan") }
          : {}),
      }) as unknown as ProviderInstance,
  );
  return Effect.gen(function* () {
    const sources = yield* Layer.build(
      Layer.mergeAll(
        Layer.fresh(layerConfigSources),
        Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({}),
        Layer.mock(ServerBrowser.ServerBrowser)({}),
      ),
    );
    const handlers = yield* Effect.gen(function* () {
      return yield* Layer.build(
        layerWsRpc(
          {
            sessionId: AuthSessionId.make("catalog-test"),
            subject: "catalog-test",
            method: "browser-session-cookie",
            scopes,
            principalKind: "person",
          },
          {
            hasHost: Effect.succeed(false),
            attach: () => Stream.die("unused connection catalog"),
            respond: () => Effect.die("unused connection catalog"),
            invoke: () => Effect.die("unused connection catalog"),
          },
          { surface: "mobile" },
          {},
          yield* PreviewAutomationBroker.PreviewAutomationBroker,
          yield* ServerBrowser.ServerBrowser,
          () => Effect.void,
        ).pipe(
          Layer.provide(
            Layer.mergeAll(
              layerUnusedConfigRpcServices,
              layerConfigEnvironment,
              Layer.mock(ScratchThreadPromotion.ScratchThreadPromotion)({}),
              Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
                listInstances: Effect.succeed(instances),
                getInstance: (id) =>
                  Effect.succeed(instances.find((instance) => instance.instanceId === id)),
              }),
              Layer.mock(ProviderRegistry.ProviderRegistry)({
                getProviders: providers,
                streamChanges: options.providerChanges ?? Stream.never,
                refresh: () =>
                  Effect.sync(() => {
                    options.recordRefresh?.();
                    return options.providers;
                  }),
                refreshWorkspaceSnapshot: () => providers,
              }),
              Layer.mock(ExternalLauncher.ExternalLauncher)({
                resolveAvailableEditors: () => Effect.succeed([]),
                // @effect-diagnostics-next-line effectSucceedWithVoid:off - This optional result requires undefined, not the wider void type.
                resolveFileManagerRevealKind: () => Effect.succeed(undefined),
              }),
              Layer.mock(ProjectService.ProjectService)({
                workspaceScanDirectory: (cwd) => Effect.succeed(cwd),
              }),
              Layer.mock(UsageLimitSources.UsageLimitSources)({
                current: Effect.succeed([]),
                refresh: Effect.void,
                streamChanges: Stream.make([]),
                projectProviders: options.projectProviders ?? Effect.succeed,
              }),
              Layer.mock(RemoteOpenTargets.RemoteOpenTargets)({
                resolveTargets: () => Effect.succeed([]),
              }),
              Layer.mock(DirectEndpoints.DirectEndpoints)({
                resolve: () => Effect.succeed([]),
                resolveAvailable: () => Effect.succeed([]),
              }),
              Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
                scratchRoot: Effect.succeedNone,
                namedProjectsRoot: process.cwd(),
              }),
              Layer.mock(EnvironmentAuth.EnvironmentAuth)({
                getDescriptor: () =>
                  Effect.succeed({
                    policy: "loopback-browser",
                    bootstrapMethods: [],
                    sessionMethods: ["browser-session-cookie"],
                    sessionCookieName: "catalog-test",
                  }),
              }),
            ),
          ),
        ),
      );
    }).pipe(Effect.provideContext(sources));
    return yield* RpcTest.makeClient(
      RpcGroup.make(WsSubscribeServerConfigRpc, WsServerRefreshProvidersRpc).middleware(
        RpcScopeAuthorization,
      ),
    ).pipe(Effect.provideContext(handlers), Effect.provide(RpcAuthorization.layer(scopes)));
  });
}
