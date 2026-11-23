import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect } from "@effect/vitest";
import { EnvironmentId, ProviderDriverKind } from "@goat/contracts";
import * as ProviderHost from "@goat/provider-core/server/ProviderHost";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as ModelManifest from "./ModelManifest.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PortScanner from "../preview/PortScanner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderHostLive from "./ProviderHostLive.ts";
import { providerHostLayer } from "./ProviderInstanceRegistryHydration.ts";

it.effect("provider hydration gets discovery even if an earlier host was built without it", () =>
  Effect.gen(function* () {
    const seen = new Map<string, ProviderHost.ProviderHost["Service"]>();
    const capture = (key: string) =>
      Layer.effectDiscard(
        Effect.map(ProviderHost.ProviderHost, (host) => {
          seen.set(key, host);
        }),
      );
    const deps = ServerConfig.layerTest(process.cwd(), { prefix: "provider-host-discovery" }).pipe(
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      Layer.provideMerge(Layer.mock(ServerSecretStore.ServerSecretStore)({})),
      Layer.provideMerge(Layer.mock(BackgroundPolicy.BackgroundPolicy)({})),
      Layer.provideMerge(ServerSettings.ServerSettingsService.layerTest()),
      Layer.provideMerge(
        Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(EnvironmentId.make("test")),
        }),
      ),
    );
    const early = capture("early").pipe(Layer.provide(ProviderHostLive.layer), Layer.provide(deps));
    const hydrated = capture("hydrated").pipe(
      Layer.provide(providerHostLayer),
      Layer.provide(Layer.mock(PortScanner.PortDiscovery)({ retainAgent: Effect.void })),
      Layer.provide(deps),
    );
    const memo = yield* Layer.makeMemoMap;
    const scope = yield* Effect.scope;
    yield* Layer.buildWithMemoMap(early, memo, scope);
    yield* Layer.buildWithMemoMap(hydrated, memo, scope);
    expect(seen.get("early")?.retainAgentPortDiscovery).toBeUndefined();
    expect(seen.get("hydrated")?.retainAgentPortDiscovery).toBeDefined();
  }),
);

it.effect("provider compatibility reads updated policy without rebuilding the host", () =>
  Effect.gen(function* () {
    const policy = (status: "broken" | "supported") => ({
      ...ModelManifest.BUNDLED_MODEL_MANIFEST,
      compatibility: [
        { driver: "opencode", t3CodeRange: ">=0.0.1", ranges: [{ range: ">=1.0.0", status }] },
      ],
    });
    const current = yield* Ref.make(policy("broken"));
    const deps = ServerConfig.layerTest(process.cwd(), { prefix: "provider-host-manifest" }).pipe(
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      Layer.provideMerge(Layer.mock(ServerSecretStore.ServerSecretStore)({})),
      Layer.provideMerge(Layer.mock(BackgroundPolicy.BackgroundPolicy)({})),
      Layer.provideMerge(ServerSettings.ServerSettingsService.layerTest()),
      Layer.provideMerge(
        Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(EnvironmentId.make("test")),
        }),
      ),
      Layer.provideMerge(Layer.mock(ModelManifest.ModelManifest)({ current: Ref.get(current) })),
    );
    const context = yield* Layer.build(ProviderHostLive.layer.pipe(Layer.provide(deps)));
    const host = Context.get(context, ProviderHost.ProviderHost);
    const driver = ProviderDriverKind.make("opencode");
    expect((yield* host.compatibility(driver, "1.14.19"))?.status).toBe("broken");
    yield* Ref.set(current, policy("supported"));
    expect((yield* host.compatibility(driver, "1.14.19"))?.status).toBe("supported");
  }),
);
