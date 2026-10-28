import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  AuthHubProxyScope,
  AuthStandardClientScopes,
  ProviderDriverKind,
  ProviderInstanceId,
  WS_METHODS,
} from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as RpcTest from "effect/rpc/RpcTest";
import * as SqlClient from "effect/sql/SqlClient";
import * as Config from "../config.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Routes from "../provider/CodexRouteService.ts";
import * as Settings from "../serverSettings.ts";
import * as Auth from "./EnvironmentAuth.ts";
import * as Access from "./HubConnectAccess.ts";
import * as Secrets from "./ServerSecretStore.ts";
import * as Sessions from "./SessionStore.ts";
import * as RpcAuthorization from "./RpcAuthorization.ts";
import * as SettingsRpc from "./SettingsRpc.ts";

const layer = Routes.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(Auth.layer, Settings.layer)),
  Layer.provideMerge(Routes.layerState),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provide(Secrets.layer),
  Layer.provide(Environment.layerIdentity),
  Layer.provideMerge(Config.layerTest(process.cwd(), { prefix: "goat-connect-settings-rpc-" })),
  Layer.provideMerge(NodeServices.layer),
);
const tags = [...RpcAuthorization.AuthorizedWsRpcGroup.requests.values()].map((rpc) => rpc._tag);
const group = RpcAuthorization.AuthorizedWsRpcGroup.omit(
  ...tags.filter(
    (tag): tag is Exclude<typeof tag, typeof WS_METHODS.serverUpdateSettings> =>
      tag !== WS_METHODS.serverUpdateSettings,
  ),
);
const instanceId = ProviderInstanceId.make("race-provider");
const mutation = {
  operation: "create" as const,
  instanceId,
  instance: {
    driver: ProviderDriverKind.make("codex"),
    displayName: "Queued provider",
    config: {},
  },
};

it.effect.each([false, true])(
  "RPC queued behind settings cannot commit after revocation (mixed provider: %s)",
  (mixed) =>
    Effect.gen(function* () {
      const settings = yield* Settings.ServerSettingsService;
      const sessions = yield* Sessions.SessionStore;
      const auth = yield* Auth.EnvironmentAuth;
      const access = yield* Access.HubConnectAccess;
      const fs = yield* FileSystem.FileSystem;
      const config = yield* Config.ServerConfig;
      yield* settings.start;
      yield* settings.updateSettings({ hub: { enabled: true, connectDevicesHubProxy: true } });
      const issued = yield* auth.issueSession({ scopes: AuthStandardClientScopes });
      const update = yield* SettingsRpc.make(issued);
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.serverUpdateSettings, update),
            RpcAuthorization.layer(issued.scopes),
          ),
        ),
      );
      const before = yield* fs.readFileString(config.settingsPath);
      const generation = (yield* access.current).generation;
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const queued = yield* Deferred.make<void>();
      const holder = yield* settings
        .withSettingsSnapshot(() =>
          Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(held);
      const originalUpdate = settings.updateSettings;
      const originalProviderUpdate = settings.updateProviderInstance;
      using _update = vi
        .spyOn(settings, "updateSettings")
        .mockImplementation((...args) =>
          Deferred.succeed(queued, undefined).pipe(Effect.andThen(originalUpdate(...args))),
        );
      using _providerUpdate = vi
        .spyOn(settings, "updateProviderInstance")
        .mockImplementation((...args) =>
          Deferred.succeed(queued, undefined).pipe(Effect.andThen(originalProviderUpdate(...args))),
        );
      const pending = yield* client[WS_METHODS.serverUpdateSettings]({
        patch: { hub: { connectDevicesHubProxy: false } },
        ...(mixed ? { providerInstanceMutation: mutation } : {}),
      }).pipe(Effect.result, Effect.forkScoped);
      yield* Deferred.await(queued);
      yield* sessions.revoke(issued.sessionId);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      expect(yield* Fiber.join(pending)).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ServerSettingsError" },
      });
      expect(yield* fs.readFileString(config.settingsPath)).toBe(before);
      expect((yield* settings.getSettings).providerInstances[instanceId]).toBeUndefined();
      expect(yield* access.current).toMatchObject({ generation, allowed: true });
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect(
  "queued mixed RPC denies a withdrawn Connect generation even when failed hygiene leaves its session active",
  () =>
    Effect.gen(function* () {
      const settings = yield* Settings.ServerSettingsService;
      const sessions = yield* Sessions.SessionStore;
      const access = yield* Access.HubConnectAccess;
      const fs = yield* FileSystem.FileSystem;
      const config = yield* Config.ServerConfig;
      const sql = yield* SqlClient.SqlClient;
      const state = yield* Routes.CodexRouteState;
      yield* settings.start;
      const changes = yield* settings.subscribeProviderChanges!;
      yield* changes.pipe(
        Stream.runForEach(({ revision }) => state.applied(revision)),
        Effect.forkScoped,
      );
      yield* settings.updateSettings({ hub: { enabled: true, connectDevicesHubProxy: true } });
      const issued = yield* access.withPolicy((policy) =>
        sessions.issue({
          subject: "cloud-connect",
          scopes: [...AuthStandardClientScopes, AuthHubProxyScope],
          connectAccessGeneration: policy.generation,
        }),
      );
      const caller = yield* sessions.verify(issued.token);
      const update = yield* SettingsRpc.make(caller);
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.serverUpdateSettings, update),
            RpcAuthorization.layer(caller.scopes),
          ),
        ),
      );
      const before = yield* fs.readFileString(config.settingsPath);
      const generation = (yield* access.current).generation;
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const queued = yield* Deferred.make<void>();
      const holder = yield* settings
        .withSettingsSnapshot(() =>
          Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(held);
      const originalProviderUpdate = settings.updateProviderInstance;
      using _providerUpdate = vi
        .spyOn(settings, "updateProviderInstance")
        .mockImplementation((...args) =>
          Deferred.succeed(queued, undefined).pipe(Effect.andThen(originalProviderUpdate(...args))),
        );
      const pending = yield* client[WS_METHODS.serverUpdateSettings]({
        patch: { hub: { enabled: false, connectDevicesHubProxy: false } },
        providerInstanceMutation: mutation,
      }).pipe(Effect.result, Effect.forkScoped);
      yield* Deferred.await(queued);
      yield* sql`CREATE TRIGGER fail_connect_cleanup BEFORE UPDATE ON auth_sessions WHEN NEW.revoked_at IS NOT NULL BEGIN SELECT RAISE(FAIL, 'injected hygiene failure'); END`;
      try {
        yield* access.commitPolicy(false, Effect.void);
        expect(yield* access.current).toEqual({
          generation: generation + 1,
          allowed: false,
          fenced: false,
        });
        expect(
          (yield* sessions.listActive()).find((session) => session.sessionId === caller.sessionId),
        ).toMatchObject({
          subject: "cloud-connect",
          scopes: [...AuthStandardClientScopes, AuthHubProxyScope],
        });
        expect((yield* sessions.verify(issued.token)).connectAccessGeneration).toBe(generation);
        expect(yield* fs.readFileString(config.settingsPath)).toBe(before);
      } finally {
        yield* Deferred.succeed(release, undefined);
      }
      yield* Fiber.join(holder);
      expect(yield* Fiber.join(pending)).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ServerSettingsError" },
      });
      expect(yield* fs.readFileString(config.settingsPath)).toBe(before);
      const after = yield* settings.getSettings;
      expect(after.hub).toMatchObject({ enabled: true, connectDevicesHubProxy: true });
      expect(after.providerInstances[instanceId]).toBeUndefined();
      expect(
        (yield* sessions.listActive()).some((session) => session.sessionId === caller.sessionId),
      ).toBe(true);
      expect(yield* access.current).toEqual({
        generation: generation + 1,
        allowed: false,
        fenced: false,
      });
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect(
  "RPC mixed and provider-only commits preserve omitted hub fields and provider-only authority",
  () =>
    Effect.gen(function* () {
      const settings = yield* Settings.ServerSettingsService;
      const auth = yield* Auth.EnvironmentAuth;
      const state = yield* Routes.CodexRouteState;
      yield* settings.start;
      const changes = yield* settings.subscribeProviderChanges!;
      yield* changes.pipe(
        Stream.runForEach(({ revision }) => state.applied(revision)),
        Effect.forkScoped,
      );
      yield* settings.updateSettings({ hub: { enabled: true, connectDevicesHubProxy: true } });
      const full = yield* SettingsRpc.make(
        yield* auth.issueSession({ scopes: AuthStandardClientScopes }),
      );
      const mixed = yield* full({
        patch: { hub: { enabled: false } },
        providerInstanceMutation: mutation,
      });
      expect(mixed.hub).toMatchObject({ enabled: false, connectDevicesHubProxy: true });
      expect(mixed.providerInstances[instanceId]?.displayName).toBe("Queued provider");
      const providerOnly = yield* SettingsRpc.make(
        yield* auth.issueSession({ scopes: ["providers:manage"] }),
      );
      const updated = yield* providerOnly({
        patch: {},
        providerInstanceMutation: {
          operation: "upsert",
          instanceId,
          instance: { ...mutation.instance, displayName: "Provider only" },
        },
      });
      expect(updated.providerInstances[instanceId]?.displayName).toBe("Provider only");
      expect(updated.hub).toMatchObject({ enabled: false, connectDevicesHubProxy: true });
      const denied = yield* providerOnly({
        patch: { hub: { enabled: true } },
        providerInstanceMutation: {
          operation: "upsert",
          instanceId,
          instance: { ...mutation.instance, displayName: "Denied" },
        },
      }).pipe(Effect.result);
      expect(denied).toMatchObject({ _tag: "Failure" });
      expect((yield* settings.getSettings).providerInstances[instanceId]?.displayName).toBe(
        "Provider only",
      );
    }).pipe(Effect.scoped, Effect.provide(layer)),
);
