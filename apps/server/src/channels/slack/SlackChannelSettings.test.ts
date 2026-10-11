import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { SlackChannelConnectionId, type SlackChannelSettingsError } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { describe } from "vite-plus/test";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as SlackChannelSettings from "../SlackChannelSettings.ts";
import * as SlackChannelRuntime from "./SlackChannelRuntime.ts";
import * as SlackChannelSettingsLive from "./SlackChannelSettings.live.ts";
import { makeFakeGateway, makeFakeTransportRegistry, owner } from "./slackChannelTestSupport.ts";
import * as SlackSdk from "./SlackSdk.ts";
import { makeFakeSlackSdk, type FakeSlackSdk } from "./slackSdkFake.ts";

const APP_TOKEN = "xapp-1-SENTINEL-app";
const BOT_TOKEN = "xoxb-SENTINEL-bot";

type SecretStoreOverrides = Partial<
  Pick<ServerSecretStore.ServerSecretStore["Service"], "get" | "set" | "remove">
>;

/** One server start against `baseDir`. Building it again on the same directory is a restart. */
const serverLayer = (
  baseDir: string,
  sdk: FakeSlackSdk,
  secretOverrides: { current: SecretStoreOverrides } = { current: {} },
  onApply: (connection: SlackChannelRuntime.SlackRuntimeConnection) => Effect.Effect<void> = () =>
    Effect.void,
) => {
  const config = ServerConfig.layerTest(process.cwd(), baseDir);
  const secrets = Layer.effect(
    ServerSecretStore.ServerSecretStore,
    Effect.gen(function* () {
      const store = yield* ServerSecretStore.ServerSecretStore;
      return ServerSecretStore.ServerSecretStore.of({
        ...store,
        get: (name) => (secretOverrides.current.get ?? store.get)(name),
        set: (name, value) => (secretOverrides.current.set ?? store.set)(name, value),
        remove: (name) => (secretOverrides.current.remove ?? store.remove)(name),
      });
    }),
  ).pipe(Layer.provide(ServerSecretStore.layer));
  // The real runtime, with a hook that observes each apply before it runs.
  const runtime = Layer.effect(
    SlackChannelRuntime.SlackChannelRuntime,
    Effect.gen(function* () {
      const real = yield* SlackChannelRuntime.SlackChannelRuntime;
      return SlackChannelRuntime.SlackChannelRuntime.of({
        ...real,
        apply: (connection) => onApply(connection).pipe(Effect.andThen(real.apply(connection))),
      });
    }),
  ).pipe(
    Layer.provide(SlackChannelRuntime.layer),
    Layer.provideMerge(
      Layer.mergeAll(sdk.layer, makeFakeGateway().layer, makeFakeTransportRegistry().layer),
    ),
  );
  return Layer.mergeAll(runtime, secrets).pipe(
    Layer.provideMerge(config),
    Layer.provideMerge(NodeServices.layer),
  );
};

/** Waits until some connection reports `connected`. */
const awaitConnected = (settings: Effect.Success<typeof SlackChannelSettingsLive.make>) =>
  settings.streamStatus().pipe(
    Stream.filter((event) => event.status === "connected"),
    Stream.runHead,
    Effect.asVoid,
  );

const withServer = <A, E>(
  baseDir: string,
  sdk: FakeSlackSdk,
  body: (
    settings: Effect.Success<typeof SlackChannelSettingsLive.make>,
  ) => Effect.Effect<
    A,
    E,
    | FileSystem.FileSystem
    | Path.Path
    | ServerConfig.ServerConfig
    | SlackChannelRuntime.SlackChannelRuntime
  >,
  secretOverrides?: { current: SecretStoreOverrides },
  onApply?: (connection: SlackChannelRuntime.SlackRuntimeConnection) => Effect.Effect<void>,
) =>
  Effect.scoped(
    Effect.flatMap(SlackChannelSettingsLive.make, body).pipe(
      Effect.provide(serverLayer(baseDir, sdk, secretOverrides, onApply)),
    ),
  );

const tempBaseDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "t3-slack-settings-test-" });
}).pipe(Effect.provide(NodeServices.layer));

const reason = (error: SlackChannelSettingsError) => error.reason;

const fileState = (baseDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const settingsPath = path.join(config.stateDir, "slack-channel-settings.json");
    const exists = yield* fs.exists(settingsPath);
    const secretPath = (name: string) => path.join(config.secretsDir, `${name}.bin`);
    return {
      settingsPath,
      settings: exists ? yield* fs.readFileString(settingsPath) : undefined,
      secretExists: (name: string) => fs.exists(secretPath(name)),
      mode: (file: string) => Effect.map(fs.stat(file), (info) => Number(info.mode) & 0o777),
      secretPath,
      baseDir,
    };
  });

describe("SlackChannelSettings.live", () => {
  it.effect("creates a connection, keeps tokens in the secret store, and survives a restart", () =>
    Effect.gen(function* () {
      const baseDir = yield* tempBaseDir;
      const sdk = makeFakeSlackSdk();
      const connectionId = yield* withServer(baseDir, sdk, (settings) =>
        Effect.gen(function* () {
          const created = yield* settings.configure(
            {
              enabled: true,
              appToken: APP_TOKEN,
              botToken: BOT_TOKEN,
              allowedChannelIds: ["C0ALLOWED"],
            },
            owner,
          );
          assert.match(created.connectionId, /^slack-[a-f0-9]{12}$/);
          assert.equal(created.hasAppToken, true);
          assert.equal(created.hasBotToken, true);
          assert.equal(created.teamId, "T0TEAM");
          assert.equal(created.botUserId, "U0BOT");
          assert(!JSON.stringify(created).includes("SENTINEL"));
          yield* awaitConnected(settings);
          const [listed] = yield* settings.get();
          assert.equal(listed?.status, "connected");

          const files = yield* fileState(baseDir);
          assert(files.settings !== undefined && !files.settings.includes("SENTINEL"));
          assert(files.settings.includes(owner.principalId));
          assert.equal(yield* files.mode(files.settingsPath), 0o600);
          const appSecret = files.secretPath(
            SlackChannelSettingsLive.appTokenSecretName(created.connectionId),
          );
          assert.equal(yield* files.mode(appSecret), 0o600);
          const fs = yield* FileSystem.FileSystem;
          assert.equal(yield* fs.readFileString(appSecret), APP_TOKEN);

          // Omitted tokens are kept; nothing is validated again.
          const validations = sdk.calls.filter(
            (c) => c === "openConnection" || c === "authTest",
          ).length;
          const updated = yield* settings.configure({
            connectionId: created.connectionId,
            enabled: true,
            allowedChannelIds: ["C0ALLOWED", "C0SECOND"],
          });
          assert.deepEqual(updated.allowedChannelIds, ["C0ALLOWED", "C0SECOND"]);
          assert.equal(updated.hasBotToken, true);
          assert.equal(
            sdk.calls.filter((c) => c === "openConnection").length +
              sdk.calls.filter((c) => c === "authTest").length,
            validations + 1, // the runtime's own auth.test on reconnect
          );

          yield* settings.disconnect({ connectionId: created.connectionId });
          const [disconnected] = yield* settings.get();
          assert.equal(disconnected?.enabled, false);
          assert.equal(disconnected?.status, "disabled");
          assert.equal(disconnected?.hasAppToken, true);
          return created.connectionId;
        }),
      );

      yield* withServer(baseDir, sdk, (settings) =>
        Effect.gen(function* () {
          const [restored] = yield* settings.get();
          assert.equal(restored?.connectionId, connectionId);
          assert.equal(restored?.enabled, false);
          // Re-enabling needs no owner from the caller: the stored owner is used.
          yield* settings.configure({ connectionId, enabled: true });
          yield* awaitConnected(settings);
          const [enabled] = yield* settings.get();
          assert.equal(enabled?.status, "connected");
        }),
      );
    }),
  );

  it.effect("refuses a new connection without an owner or without both tokens", () =>
    Effect.gen(function* () {
      const baseDir = yield* tempBaseDir;
      yield* withServer(baseDir, makeFakeSlackSdk(), (settings) =>
        Effect.gen(function* () {
          const withoutOwner = yield* Effect.flip(
            settings.configure({ enabled: true, appToken: APP_TOKEN, botToken: BOT_TOKEN }),
          );
          assert.equal(reason(withoutOwner), "invalid_input");
          const withoutBot = yield* Effect.flip(
            settings.configure({ enabled: true, appToken: APP_TOKEN }, owner),
          );
          assert.equal(reason(withoutBot), "invalid_input");
          assert.equal((yield* fileState(baseDir)).settings, undefined);
        }),
      );
    }),
  );

  it.effect("rejects bad tokens before writing anything", () =>
    Effect.gen(function* () {
      const baseDir = yield* tempBaseDir;
      const sdk = makeFakeSlackSdk();
      yield* withServer(baseDir, sdk, (settings) =>
        Effect.gen(function* () {
          sdk.script.authTest = () => Promise.reject(sdk.failure("auth.test", "auth_invalid"));
          const invalid = yield* Effect.flip(
            settings.configure({ enabled: true, appToken: APP_TOKEN, botToken: BOT_TOKEN }, owner),
          );
          assert.equal(reason(invalid), "invalid_token");
          assert(!JSON.stringify(invalid).includes("SENTINEL"));

          sdk.script.openConnection = () =>
            Promise.reject(sdk.failure("apps.connections.open", "network"));
          const unreachable = yield* Effect.flip(
            settings.configure({ enabled: true, appToken: APP_TOKEN, botToken: BOT_TOKEN }, owner),
          );
          assert.equal(reason(unreachable), "adapter_unavailable");
          assert.equal((yield* fileState(baseDir)).settings, undefined);
          assert.deepEqual(yield* settings.get(), []);
        }),
      );
    }),
  );

  it.effect("refuses a bot token from another workspace and keeps the stored one", () =>
    Effect.gen(function* () {
      const baseDir = yield* tempBaseDir;
      const sdk = makeFakeSlackSdk();
      yield* withServer(baseDir, sdk, (settings) =>
        Effect.gen(function* () {
          const created = yield* settings.configure(
            { enabled: true, appToken: APP_TOKEN, botToken: BOT_TOKEN },
            owner,
          );
          sdk.script.authTest = () =>
            Promise.resolve({ teamId: "T0OTHER", botUserId: "U0BOT", botId: undefined });
          const error = yield* Effect.flip(
            settings.configure({
              connectionId: created.connectionId,
              enabled: true,
              botToken: "xoxb-other-workspace",
            }),
          );
          assert.equal(reason(error), "invalid_token");
          const fs = yield* FileSystem.FileSystem;
          const files = yield* fileState(baseDir);
          assert.equal(
            yield* fs.readFileString(
              files.secretPath(SlackChannelSettingsLive.botTokenSecretName(created.connectionId)),
            ),
            BOT_TOKEN,
          );
        }),
      );
    }),
  );

  it.effect(
    "clears credentials: stops the socket, deletes both tokens, forgets the workspace",
    () =>
      Effect.gen(function* () {
        const baseDir = yield* tempBaseDir;
        const sdk = makeFakeSlackSdk();
        yield* withServer(baseDir, sdk, (settings) =>
          Effect.gen(function* () {
            const created = yield* settings.configure(
              { enabled: true, appToken: APP_TOKEN, botToken: BOT_TOKEN },
              owner,
            );
            yield* awaitConnected(settings);
            const mixed = yield* Effect.flip(
              settings.configure({
                connectionId: created.connectionId,
                enabled: false,
                clearCredentials: true,
                botToken: BOT_TOKEN,
              }),
            );
            assert.equal(reason(mixed), "invalid_input");

            const cleared = yield* settings.configure({
              connectionId: created.connectionId,
              enabled: false,
              clearCredentials: true,
            });
            assert.equal(cleared.enabled, false);
            assert.equal(cleared.hasAppToken, false);
            assert.equal(cleared.hasBotToken, false);
            assert.equal(cleared.teamId, undefined);
            assert.equal(cleared.status, "disabled");
            assert(sdk.calls.includes("disconnect:0"));
            const files = yield* fileState(baseDir);
            assert.equal(
              yield* files.secretExists(
                SlackChannelSettingsLive.appTokenSecretName(created.connectionId),
              ),
              false,
            );
          }),
        );
      }),
  );

  it.effect("leaves the connection disabled when a credential change fails part-way", () =>
    Effect.gen(function* () {
      const baseDir = yield* tempBaseDir;
      const sdk = makeFakeSlackSdk();
      const overrides: { current: SecretStoreOverrides } = { current: {} };
      const connectionId = yield* withServer(
        baseDir,
        sdk,
        (settings) =>
          Effect.gen(function* () {
            const created = yield* settings.configure(
              { enabled: true, appToken: APP_TOKEN, botToken: BOT_TOKEN },
              owner,
            );
            yield* awaitConnected(settings);
            const failWrite = Effect.fail(
              new ServerSecretStore.SecretStorePersistError({
                resource: "secret",
                cause: "disk full",
              }),
            );
            overrides.current = { set: () => failWrite, remove: () => failWrite };
            const replace = yield* Effect.flip(
              settings.configure({
                connectionId: created.connectionId,
                enabled: true,
                botToken: "xoxb-replacement",
              }),
            );
            assert.equal(reason(replace), "persistence_failed");
            const clear = yield* Effect.flip(
              settings.configure({
                connectionId: created.connectionId,
                enabled: false,
                clearCredentials: true,
              }),
            );
            assert.equal(reason(clear), "persistence_failed");
            const [current] = yield* settings.get();
            assert.equal(current?.enabled, false);
            assert.equal(current?.status, "disabled");
            return created.connectionId;
          }),
        overrides,
      );
      overrides.current = {};
      yield* withServer(baseDir, sdk, (settings) =>
        Effect.gen(function* () {
          const [restarted] = yield* settings.get();
          assert.equal(restarted?.connectionId, connectionId);
          assert.equal(restarted?.enabled, false);
        }),
      );
    }),
  );

  it.effect("reports unknown and malformed connection ids as not found", () =>
    Effect.gen(function* () {
      const baseDir = yield* tempBaseDir;
      yield* withServer(baseDir, makeFakeSlackSdk(), (settings) =>
        Effect.gen(function* () {
          for (const id of ["slack-ffffffffffff", "../../secrets/x", "slack-ABC"]) {
            const connectionId = SlackChannelConnectionId.make(id);
            assert.equal(
              reason(yield* Effect.flip(settings.disconnect({ connectionId }))),
              "not_found",
            );
            assert.equal(
              reason(
                yield* Effect.flip(settings.configure({ connectionId, enabled: false }, owner)),
              ),
              "not_found",
            );
          }
        }),
      );
    }),
  );

  it.effect("keeps a damaged settings file untouched and reports it instead of overwriting", () =>
    Effect.gen(function* () {
      const baseDir = yield* tempBaseDir;
      const sdk = makeFakeSlackSdk();
      const damaged = '{"version": 1, "connections": [';
      yield* withServer(baseDir, sdk, (settings) =>
        Effect.gen(function* () {
          yield* settings.configure({ enabled: false }, owner);
          const fs = yield* FileSystem.FileSystem;
          yield* fs.writeFileString((yield* fileState(baseDir)).settingsPath, damaged);
        }),
      );
      yield* withServer(baseDir, sdk, (settings) =>
        Effect.gen(function* () {
          assert.equal(reason(yield* Effect.flip(settings.get())), "persistence_failed");
          assert.equal(
            reason(yield* Effect.flip(settings.configure({ enabled: false }, owner))),
            "persistence_failed",
          );
          assert.equal(
            reason(yield* Effect.flip(settings.streamStatus().pipe(Stream.runHead))),
            "persistence_failed",
          );
          assert.equal((yield* fileState(baseDir)).settings, damaged);
        }),
      );
    }),
  );

  it.effect("streams each connection's current status", () =>
    Effect.gen(function* () {
      const baseDir = yield* tempBaseDir;
      yield* withServer(baseDir, makeFakeSlackSdk(), (settings) =>
        Effect.gen(function* () {
          const created = yield* settings.configure(
            { enabled: true, appToken: APP_TOKEN, botToken: BOT_TOKEN },
            owner,
          );
          yield* awaitConnected(settings);
          const first = yield* settings.streamStatus().pipe(Stream.runHead);
          assert.deepEqual(Option.getOrUndefined(first), {
            connectionId: created.connectionId,
            status: "connected",
          });
        }),
      );
    }),
  );
});

describe("live layer assembly", () => {
  it.effect("composes the real SDK, runtime, and settings layers behind the settings port", () =>
    Effect.gen(function* () {
      const baseDir = yield* tempBaseDir;
      // The same graph the server assembly provides; only the gateway and registry are fakes.
      const live = SlackChannelSettingsLive.layer.pipe(
        Layer.provideMerge(SlackChannelRuntime.layer),
        Layer.provideMerge(
          Layer.mergeAll(
            SlackSdk.layer,
            makeFakeGateway().layer,
            makeFakeTransportRegistry().layer,
            ServerSecretStore.layer,
          ),
        ),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
        Layer.provideMerge(NodeServices.layer),
      );
      const listed = yield* Effect.flatMap(SlackChannelSettings.SlackChannelSettings, (settings) =>
        settings.get(),
      ).pipe(Effect.provide(live));
      assert.deepEqual(listed, []);
    }),
  );
});

describe("disconnect", () => {
  it.effect("stops the socket even when the stored tokens cannot be read", () =>
    Effect.gen(function* () {
      const baseDir = yield* tempBaseDir;
      const sdk = makeFakeSlackSdk();
      const overrides: { current: SecretStoreOverrides } = { current: {} };
      yield* withServer(
        baseDir,
        sdk,
        (settings) =>
          Effect.gen(function* () {
            const created = yield* settings.configure(
              { enabled: true, appToken: APP_TOKEN, botToken: BOT_TOKEN },
              owner,
            );
            yield* awaitConnected(settings);
            overrides.current = {
              get: () =>
                Effect.fail(
                  new ServerSecretStore.SecretStoreReadError({
                    resource: "secret",
                    cause: "locked",
                  }),
                ),
            };
            yield* settings.disconnect({ connectionId: created.connectionId });
            assert(sdk.calls.includes("disconnect:0"));
            assert.equal(sdk.sessions[0]?.listenerCount(), 0);
            const fs = yield* FileSystem.FileSystem;
            const saved = yield* fs.readFileString((yield* fileState(baseDir)).settingsPath);
            assert(saved.includes('"enabled":false'));
          }),
        overrides,
      );
    }),
  );

  it.effect("finishes stopping a connection it saved as disabled even if interrupted", () =>
    Effect.gen(function* () {
      const baseDir = yield* tempBaseDir;
      const sdk = makeFakeSlackSdk();
      const reachedApply = yield* Deferred.make<void>();
      let watched: string | undefined;
      const onApply = (connection: SlackChannelRuntime.SlackRuntimeConnection) =>
        connection.connectionId === watched && !connection.enabled
          ? Deferred.succeed(reachedApply, undefined)
          : Effect.void;
      yield* withServer(
        baseDir,
        sdk,
        (settings) =>
          Effect.gen(function* () {
            const runtime = yield* SlackChannelRuntime.SlackChannelRuntime;
            const awaitConnectedId = (id: string) =>
              settings.streamStatus().pipe(
                Stream.filter((event) => event.connectionId === id && event.status === "connected"),
                Stream.runHead,
              );
            const first = yield* settings.configure(
              { enabled: true, appToken: APP_TOKEN, botToken: BOT_TOKEN },
              owner,
            );
            yield* awaitConnectedId(first.connectionId);
            const second = yield* settings.configure(
              { enabled: true, appToken: APP_TOKEN, botToken: BOT_TOKEN },
              owner,
            );
            yield* awaitConnectedId(second.connectionId);

            // Keep the runtime busy stopping the first connection, so disabling the second
            // has already saved its file and is waiting to stop it.
            const releaseDisconnect = sdk.holdDisconnects();
            const stoppingFirst = yield* Effect.forkChild(
              runtime.apply({
                connectionId: first.connectionId,
                enabled: false,
                allowedChannelIds: [],
                appToken: undefined,
                botToken: undefined,
                expectedTeamId: undefined,
                owner,
              }),
            );
            yield* Effect.promise(() => sdk.waitForCall("disconnect:0"));
            watched = second.connectionId;
            const disabling = yield* Effect.forkChild(
              settings.configure({ connectionId: second.connectionId, enabled: false }),
            );
            yield* Deferred.await(reachedApply);
            const interrupting = yield* Effect.forkChild(Fiber.interrupt(disabling));
            releaseDisconnect();
            yield* Fiber.join(interrupting);
            yield* Fiber.join(stoppingFirst);

            const current = (yield* settings.get()).find(
              (connection) => connection.connectionId === second.connectionId,
            );
            assert.equal(current?.enabled, false);
            assert.equal(current?.status, "disabled");
            assert(sdk.calls.includes("disconnect:1"));
          }),
        undefined,
        onApply,
      );
    }),
  );
});
