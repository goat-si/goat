import { expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, WS_METHODS } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as RpcTest from "effect/rpc/RpcTest";
import * as Settings from "../serverSettings.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Routes from "../provider/CodexRouteService.ts";
import * as Runtime from "./ConnectHubRuntime.testkit.ts";
import * as Authorization from "./RpcAuthorization.ts";
import * as Write from "./SettingsRpc.ts";

const method = WS_METHODS.serverUpdateSettings;
const tags = [...Authorization.AuthorizedWsRpcGroup.requests.values()].map((rpc) => rpc._tag);
const group = Authorization.AuthorizedWsRpcGroup.omit(
  ...tags.filter((tag): tag is Exclude<(typeof tags)[number], typeof method> => tag !== method),
);
const mutation = {
  operation: "upsert" as const,
  instanceId: ProviderInstanceId.make("custom-codex"),
  instance: {
    driver: ProviderDriverKind.make("codex"),
    displayName: "Personal Codex",
    enabled: true,
    config: {},
  },
};

it.effect.each([false, true])(
  "RPC settings queued behind the real settings lock rechecks a revoked caller (mixed=%s)",
  (mixed) =>
    Effect.gen(function* () {
      const watch = yield* Runtime.watcher;
      const runtime = yield* Runtime.open({ fs: watch.fs });
      yield* runtime.settings.start;
      yield* runtime.settings.updateSettings({
        hub: { enabled: true, connectDevicesHubProxy: true },
      });
      const session = yield* runtime.sessions
        .issue({ scopes: ["settings:write", "providers:manage"] })
        .pipe(Effect.flatMap((issued) => runtime.sessions.verify(issued.token)));
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const queued = yield* Deferred.make<void>();
      const holder = yield* runtime.settings
        .withSettingsSnapshot(() =>
          Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(held);
      const observed = {
        ...runtime.settings,
        updateSettings: (...args: Parameters<typeof runtime.settings.updateSettings>) =>
          Deferred.succeed(queued, undefined).pipe(
            Effect.andThen(runtime.settings.updateSettings(...args)),
          ),
        updateProviderInstance: (
          ...args: Parameters<typeof runtime.settings.updateProviderInstance>
        ) =>
          Deferred.succeed(queued, undefined).pipe(
            Effect.andThen(runtime.settings.updateProviderInstance(...args)),
          ),
      };
      yield* Effect.gen(function* () {
        const write = yield* Write.make(session);
        const client = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.merge(
              group.toLayerHandler(method, (input) =>
                write(input).pipe(Effect.map(Settings.redactServerSettingsForClient)),
              ),
              Authorization.layer(session.scopes),
            ),
          ),
        );
        const pending = yield* client[method]({
          patch: { hub: { connectDevicesHubProxy: false }, newWorktreesStartFromOrigin: true },
          ...(mixed ? { providerInstanceMutation: mutation } : {}),
        }).pipe(Effect.result, Effect.forkScoped);
        yield* Deferred.await(queued);
        yield* runtime.sessions.revoke(session.sessionId);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(holder);
        expect(yield* Fiber.join(pending)).toMatchObject({ _tag: "Failure" });
        expect((yield* runtime.settings.getSettings).hub.connectDevicesHubProxy).toBe(true);
        expect((yield* runtime.access.current).allowed).toBe(true);
      }).pipe(
        Effect.provide(
          Routes.layer.pipe(
            Layer.provide(Routes.layerState),
            Layer.provide(Environment.layerIdentity),
          ),
        ),
        Effect.provideService(Settings.ServerSettingsService, observed),
        Effect.provideContext(runtime.context),
      );
    }).pipe(Effect.scoped, Effect.provide(Runtime.storage)),
);

it.effect(
  "provider-only RPC mutation preserves omitted hub consent; a mixed mutation requires settings authority",
  () =>
    Effect.gen(function* () {
      const watch = yield* Runtime.watcher;
      const runtime = yield* Runtime.open({ fs: watch.fs });
      yield* runtime.settings.start;
      yield* runtime.settings.updateSettings({
        hub: { enabled: true, connectDevicesHubProxy: true },
      });
      const session = yield* runtime.sessions
        .issue({ scopes: ["providers:manage"] })
        .pipe(Effect.flatMap((issued) => runtime.sessions.verify(issued.token)));
      yield* Effect.gen(function* () {
        const write = yield* Write.make(session);
        const client = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.merge(
              group.toLayerHandler(method, (input) =>
                write(input).pipe(Effect.map(Settings.redactServerSettingsForClient)),
              ),
              Authorization.layer(session.scopes),
            ),
          ),
        );
        expect(
          yield* client[method]({
            patch: { hub: { connectDevicesHubProxy: false } },
            providerInstanceMutation: mutation,
          }).pipe(Effect.result),
        ).toMatchObject({ _tag: "Failure" });
        const value = yield* client[method]({ patch: {}, providerInstanceMutation: mutation });
        expect(value.hub.connectDevicesHubProxy).toBe(true);
        expect((yield* runtime.settings.getSettings).hub).toMatchObject({
          enabled: true,
          connectDevicesHubProxy: true,
        });
      }).pipe(
        Effect.provide(
          Routes.layer.pipe(
            Layer.provide(Routes.layerState),
            Layer.provide(Environment.layerIdentity),
          ),
        ),
        Effect.provideContext(runtime.context),
      );
    }).pipe(Effect.scoped, Effect.provide(Runtime.storage)),
);

it.effect(
  "a queued mixed RPC cannot use a surviving cloud row after its generation is withdrawn",
  () =>
    Effect.gen(function* () {
      const watch = yield* Runtime.watcher;
      const runtime = yield* Runtime.open({ fs: watch.fs });
      yield* runtime.settings.start;
      yield* runtime.settings.updateSettings({
        hub: { enabled: true, connectDevicesHubProxy: true },
      });
      const issued = yield* runtime.sessions.issue({
        subject: "cloud-connect",
        scopes: ["hub:proxy", "settings:write", "providers:manage"],
        connectAccessGeneration: (yield* runtime.access.current).generation,
      });
      const session = yield* runtime.sessions.verify(issued.token);
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const queued = yield* Deferred.make<void>();
      const holder = yield* runtime.settings
        .withSettingsSnapshot(() =>
          Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(held);
      const observed = {
        ...runtime.settings,
        updateProviderInstance: (
          ...args: Parameters<typeof runtime.settings.updateProviderInstance>
        ) =>
          Deferred.succeed(queued, undefined).pipe(
            Effect.andThen(runtime.settings.updateProviderInstance(...args)),
          ),
      };
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const write = yield* Write.make(session);
        const client = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.merge(
              group.toLayerHandler(method, (input) =>
                write(input).pipe(Effect.map(Settings.redactServerSettingsForClient)),
              ),
              Authorization.layer(session.scopes),
            ),
          ),
        );
        const pending = yield* client[method]({
          patch: { hub: { connectDevicesHubProxy: false } },
          providerInstanceMutation: mutation,
        }).pipe(Effect.result, Effect.forkScoped);
        yield* Deferred.await(queued);
        yield* sql`CREATE TRIGGER fail_cloud_cleanup BEFORE UPDATE ON auth_sessions WHEN OLD.subject = 'cloud-connect' BEGIN SELECT RAISE(FAIL, 'hygiene held'); END`;
        yield* runtime.access.commitPolicy(false, Effect.void);
        expect(
          (yield* runtime.sessions.listActive()).some((row) => row.sessionId === session.sessionId),
        ).toBe(true);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(holder);
        expect(yield* Fiber.join(pending)).toMatchObject({ _tag: "Failure" });
        const settings = yield* runtime.settings.getSettings;
        expect(settings.providerInstances[mutation.instanceId]).toBeUndefined();
        expect(settings.hub.connectDevicesHubProxy).toBe(true);
      }).pipe(
        Effect.provide(
          Routes.layer.pipe(
            Layer.provide(Routes.layerState),
            Layer.provide(Environment.layerIdentity),
          ),
        ),
        Effect.provideService(Settings.ServerSettingsService, observed),
        Effect.provideContext(runtime.context),
      );
    }).pipe(Effect.scoped, Effect.provide(Runtime.storage)),
);
