import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Config from "../config.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Settings from "../serverSettings.ts";
import * as Auth from "./EnvironmentAuth.ts";
import * as Policy from "./EnvironmentAuthPolicy.ts";
import * as Access from "./HubConnectAccess.ts";
import * as Grants from "./PairingGrantStore.ts";
import * as Secrets from "./ServerSecretStore.ts";
import * as Sessions from "./SessionStore.ts";

export const storage = Sqlite.layerMemory.pipe(
  Layer.provideMerge(Config.layerTest(process.cwd(), { prefix: "goat-connect-acceptance-" })),
  Layer.provideMerge(NodeServices.layer),
);
const services = Layer.mergeAll(
  Layer.effect(Auth.EnvironmentAuth, Auth.make).pipe(Layer.provide(Policy.layer)),
  Settings.layerWithConnectAccess,
).pipe(Layer.provideMerge(Secrets.layer), Layer.provideMerge(Environment.layerIdentity));

export const open = Effect.fn("ConnectHubRuntime.open")(function* (
  overrides: {
    readonly fs?: FileSystem.FileSystem;
    readonly access?: (
      service: Access.HubConnectAccess["Service"],
    ) => Access.HubConnectAccess["Service"];
    readonly grants?: (
      service: Grants.PairingGrantStore["Service"],
    ) => Grants.PairingGrantStore["Service"];
    readonly sessions?: (
      service: Sessions.SessionStore["Service"],
    ) => Sessions.SessionStore["Service"];
  } = {},
) {
  const scope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
  const fs = overrides.fs ?? (yield* FileSystem.FileSystem);
  const base = yield* Layer.buildWithScope(Layer.fresh(Access.layer), scope).pipe(
    Effect.provideService(FileSystem.FileSystem, fs),
  );
  const access = (overrides.access ?? ((value) => value))(
    Context.get(base, Access.HubConnectAccess),
  );
  const grants = (overrides.grants ?? ((value) => value))(
    Context.get(base, Grants.PairingGrantStore),
  );
  const sessions = (overrides.sessions ?? ((value) => value))(
    Context.get(base, Sessions.SessionStore),
  );
  const dependencies = base.pipe(
    Context.add(Access.HubConnectAccess, access),
    Context.add(Grants.PairingGrantStore, grants),
    Context.add(Sessions.SessionStore, sessions),
  );
  const context = yield* Layer.buildWithScope(Layer.fresh(services), scope).pipe(
    Effect.provideContext(dependencies),
    Effect.provideService(FileSystem.FileSystem, fs),
  );
  const auth = Context.get(context, Auth.EnvironmentAuth);
  return {
    scope,
    context: Context.merge(dependencies, context),
    access,
    grants,
    sessions,
    auth,
    settings: Context.get(context, Settings.ServerSettingsService),
    close: Scope.close(scope, Exit.void),
  };
});

export const watcher = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const events = yield* PubSub.unbounded<{
    readonly event: FileSystem.WatchEvent;
    readonly seen: Deferred.Deferred<void>;
  }>();
  const installed = yield* Deferred.make<void>();
  let registrations = 0;
  const controlled: FileSystem.FileSystem = {
    ...fs,
    watch: (directory, options) =>
      Stream.unwrap(
        PubSub.subscribe(events).pipe(
          Effect.tap(() => {
            options?.onReady?.();
            registrations += 1;
            return registrations >= 2 ? Deferred.succeed(installed, undefined) : Effect.void;
          }),
          Effect.map((subscription) =>
            Stream.fromSubscription(subscription).pipe(
              Stream.filter(({ event }) => path.dirname(event.path) === directory),
              Stream.tap(({ seen }) => Deferred.succeed(seen, undefined)),
              Stream.map(({ event }) => event),
            ),
          ),
        ),
      ),
  };
  const notify = Effect.fn("ConnectHubRuntime.notify")(function* (file: string) {
    const seen = yield* Deferred.make<void>();
    yield* PubSub.publish(events, { event: { _tag: "Update" as const, path: file }, seen });
    yield* Deferred.await(seen);
  });
  return { fs: controlled, installed: Deferred.await(installed), notify };
});
