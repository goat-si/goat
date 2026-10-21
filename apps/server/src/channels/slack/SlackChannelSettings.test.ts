import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ChannelDeliveryId,
  EnvironmentId,
  ProjectId,
  SlackChannelConnectionId,
  type SlackChannelSettingsError,
} from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import * as Stream from "effect/Stream";
import { describe } from "vite-plus/test";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as PublishingServerSettings from "../testkit/PublishingServerSettings.ts";
import * as ServerConfig from "../../config.ts";
import * as SlackChannelSettings from "../SlackChannelSettings.ts";
import * as SlackChannelRuntime from "./SlackChannelRuntime.ts";
import * as SlackChannelSettingsLive from "./SlackChannelSettings.live.ts";
import {
  directMessage,
  eventCallback,
  makeFakeGateway,
  makeFakeTransportRegistry,
  owner,
} from "./slackChannelTestSupport.ts";
import * as SlackSdk from "./SlackSdk.ts";
import { makeFakeSlackSdk, type FakeSlackSdk } from "./slackSdkFake.ts";

const APP_TOKEN = "xapp-1-SENTINEL-app";
const BOT_TOKEN = "xoxb-SENTINEL-bot";

type SecretStoreOverrides = Partial<
  Pick<ServerSecretStore.ServerSecretStore["Service"], "get" | "set" | "remove">
> & {
  /** Fails reads of the matching secrets only; everything else reads the real store. */
  readonly unreadable?: (name: string) => boolean;
  /** Runs before each secret write reaches the real store. */
  readonly beforeSet?: (name: string) => Effect.Effect<void>;
};

/** One server start against `baseDir`. Building it again on the same directory is a restart. */
const serverLayer = (
  baseDir: string,
  sdk: FakeSlackSdk,
  secretOverrides: { current: SecretStoreOverrides } = { current: {} },
  onApply: (connection: SlackChannelRuntime.SlackRuntimeConnection) => Effect.Effect<void> = () =>
    Effect.void,
  fixtures = { gateway: makeFakeGateway(), registry: makeFakeTransportRegistry() },
  settingsLayer = ServerSettings.layerTest(),
) => {
  const config = ServerConfig.layerTest(process.cwd(), baseDir);
  const secrets = Layer.effect(
    ServerSecretStore.ServerSecretStore,
    Effect.gen(function* () {
      const store = yield* ServerSecretStore.ServerSecretStore;
      return ServerSecretStore.ServerSecretStore.of({
        ...store,
        get: (name) =>
          secretOverrides.current.unreadable?.(name) === true
            ? Effect.fail(
                new ServerSecretStore.SecretStorePersistError({
                  resource: "secret",
                  cause: "unreadable",
                }),
              )
            : (secretOverrides.current.get ?? store.get)(name),
        set: (name, value) =>
          (secretOverrides.current.beforeSet?.(name) ?? Effect.void).pipe(
            Effect.andThen((secretOverrides.current.set ?? store.set)(name, value)),
          ),
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
    Layer.provideMerge(Layer.mergeAll(sdk.layer, fixtures.gateway.layer, fixtures.registry.layer)),
  );
  return Layer.mergeAll(
    runtime,
    secrets,
    settingsLayer,
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(EnvironmentId.make("environment:slack-test")),
    }),
  ).pipe(Layer.provideMerge(config), Layer.provideMerge(NodeServices.layer));
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
    | ServerSettings.ServerSettingsService
  >,
  secretOverrides?: { current: SecretStoreOverrides },
  onApply?: (connection: SlackChannelRuntime.SlackRuntimeConnection) => Effect.Effect<void>,
  fixtures?: {
    gateway: ReturnType<typeof makeFakeGateway>;
    registry: ReturnType<typeof makeFakeTransportRegistry>;
  },
  settingsLayer?: Layer.Layer<ServerSettings.ServerSettingsService>,
) =>
  Effect.scoped(
    Effect.flatMap(SlackChannelSettingsLive.make, body).pipe(
      Effect.provide(serverLayer(baseDir, sdk, secretOverrides, onApply, fixtures, settingsLayer)),
    ),
  );

const tempBaseDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "goat-slack-settings-test-" });
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
          const appSecret = files.secretPath(
            SlackChannelSettingsLive.appTokenSecretName(created.connectionId),
          );
          // Windows keeps no POSIX permission bits; its profile ACLs guard these files.
          if ((yield* HostProcess.Platform) !== "win32") {
            assert.equal(yield* files.mode(files.settingsPath), 0o600);
            assert.equal(yield* files.mode(appSecret), 0o600);
          }
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
          assert.equal(disconnected?.hasBotToken, true);
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
            assert(!((yield* fileState(baseDir)).settings ?? "").includes("SavedAt"));
            assert(!((yield* fileState(baseDir)).settings ?? "").includes("revoked"));
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

describe("defaultTarget", () => {
  it.effect("returns a connection's saved defaults and none for an unknown connection", () =>
    Effect.gen(function* () {
      const baseDir = yield* tempBaseDir;
      yield* withServer(baseDir, makeFakeSlackSdk(), (settings) =>
        Effect.gen(function* () {
          const created = yield* settings.configure(
            {
              enabled: false,
              appToken: APP_TOKEN,
              botToken: BOT_TOKEN,
              defaultTarget: { projectId: ProjectId.make("project-slack") },
            },
            owner,
          );
          assert.deepEqual(
            Option.getOrUndefined(yield* settings.defaultTarget(created.connectionId)),
            { projectId: ProjectId.make("project-slack") },
          );
          assert(Option.isNone(yield* settings.defaultTarget("slack-000000000000")));
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
            ServerSettings.layerTest(),
            Layer.mock(ServerEnvironment.ServerEnvironment)({
              getEnvironmentId: Effect.succeed(EnvironmentId.make("environment:slack-test")),
            }),
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

const revoke = (
  sdk: FakeSlackSdk,
  kind: "tokens_revoked" | "app_uninstalled",
  eventTime = 1000,
) => {
  const socket = sdk.sessions.at(-1);
  assert(socket !== undefined);
  return socket.emitEnvelope(
    eventCallback(
      kind === "tokens_revoked" ? { type: kind, tokens: { bot: ["U0BOT"] } } : { type: kind },
      { event_time: eventTime },
    ),
  );
};

/** A following envelope's ACK proves the serialized revocation handler finished. */
const receiveOnlyBarrier = (sdk: FakeSlackSdk) => {
  const socket = sdk.sessions.at(-1);
  assert(socket !== undefined);
  const ordinary = socket.emitEnvelope(eventCallback(directMessage()));
  return Effect.promise(() => ordinary.acked);
};
const createConnected = (settings: Effect.Success<typeof SlackChannelSettingsLive.make>) =>
  Effect.gen(function* () {
    const created = yield* settings.configure(
      { enabled: true, appToken: APP_TOKEN, botToken: BOT_TOKEN },
      owner,
    );
    yield* awaitConnected(settings);
    return created;
  });

const assertBlockedDelivery = (
  registry: ReturnType<typeof makeFakeTransportRegistry>,
  connectionId: string,
) =>
  Effect.gen(function* () {
    const transport = registry.registered.get("slack");
    assert(transport !== undefined);
    const error = yield* Effect.flip(
      transport.send({
        deliveryId: ChannelDeliveryId.make("blocked-delivery"),
        kind: "result",
        text: "must not send",
        destination: {
          kind: "slack",
          connectionId,
          teamId: "T0TEAM",
          channelId: "C0ALLOWED",
          rootTs: "1760000000.000100",
        },
      }),
    );
    assert.equal(error.deliveryOutcome, "not_sent");
    assert.equal(error.deliveryErrorCode, "token_revoked");
  });

// Effect's TestClock starts at zero; events at 1000 seconds are beyond the five-minute margin.
describe("Slack revocation persistence", () => {
  it.effect.each([
    ["tokens_revoked", "app_uninstalled"],
    ["app_uninstalled", "tokens_revoked"],
  ] as const)(
    "converges in either order, including duplicates and uninstall dominance: %j",
    ([first, second]) =>
      Effect.gen(function* () {
        const baseDir = yield* tempBaseDir;
        const sdk = makeFakeSlackSdk();
        let id: SlackChannelConnectionId;
        const overrides: { current: SecretStoreOverrides } = { current: {} };
        yield* withServer(
          baseDir,
          sdk,
          (settings) =>
            Effect.gen(function* () {
              id = (yield* createConnected(settings)).connectionId;
              if (first === "app_uninstalled") {
                // Keep the socket receive-only after a failed deletion so the later bot event
                // arrives on the same socket and must preserve the uninstall tombstone.
                overrides.current = {
                  remove: () =>
                    Effect.fail(
                      new ServerSecretStore.SecretStorePersistError({
                        resource: "secret",
                        cause: "interrupted cleanup",
                      }),
                    ),
                };
              }
              const event = revoke(sdk, first);
              if (first === "tokens_revoked") yield* Effect.promise(() => event.acked);
              else {
                yield* receiveOnlyBarrier(sdk);
                assert.equal(event.ackCount(), 0);
              }
              const duplicate = revoke(sdk, first);
              if (first === "tokens_revoked") yield* Effect.promise(() => duplicate.acked);
              else {
                yield* receiveOnlyBarrier(sdk);
                assert.equal(duplicate.ackCount(), 0);
              }
              overrides.current = {};
              yield* Effect.promise(() => revoke(sdk, second).acked);
            }),
          overrides,
        );
        const restarted = makeFakeSlackSdk();
        yield* withServer(baseDir, restarted, (settings) =>
          Effect.gen(function* () {
            const [current] = yield* settings.get();
            assert.equal(current?.connectionId, id!);
            assert.equal(current?.hasAppToken, false);
            assert.equal(current?.hasBotToken, false);
            assert.equal(current?.lastError, "app_uninstalled");
            assert.equal(restarted.sessions.length, 0);
            assert((yield* fileState(baseDir)).settings?.includes('"revoked":"app_uninstalled"'));
          }),
        );
      }),
  );

  it.effect(
    "resumes receive-only between events across restart and reconnect with zero delivery sessions",
    () =>
      Effect.gen(function* () {
        const baseDir = yield* tempBaseDir;
        const sdk = makeFakeSlackSdk();
        yield* withServer(baseDir, sdk, (settings) =>
          Effect.gen(function* () {
            yield* createConnected(settings);
            yield* Effect.promise(() => revoke(sdk, "tokens_revoked").acked);
          }),
        );
        const restarted = makeFakeSlackSdk();
        const fixtures = { gateway: makeFakeGateway(), registry: makeFakeTransportRegistry() };
        yield* withServer(
          baseDir,
          restarted,
          (settings) =>
            Effect.gen(function* () {
              yield* Effect.promise(() => restarted.waitForCall("start:0"));
              yield* receiveOnlyBarrier(restarted);
              const [current] = yield* settings.get();
              assert(current !== undefined);
              assert.equal(current.hasBotToken, false);
              assert.equal(current.hasAppToken, true);
              yield* assertBlockedDelivery(fixtures.registry, current.connectionId);
              restarted.sessions[0]!.emitLifecycle("disconnected");
              yield* Effect.promise(() => restarted.waitForCall("disconnect:0"));
              yield* TestClock.adjust("1 second");
              yield* Effect.promise(() => restarted.waitForCall("start:1"));
              yield* receiveOnlyBarrier(restarted);
              yield* assertBlockedDelivery(fixtures.registry, current.connectionId);
              assert.equal(restarted.calls.filter((call) => call === "authTest").length, 0);
              assert.equal(restarted.posted.length, 0);
              assert.equal(fixtures.gateway.calls.length, 0);
              yield* Effect.promise(() => revoke(restarted, "tokens_revoked").acked);
              yield* Effect.promise(() => revoke(restarted, "app_uninstalled").acked);
              const [uninstalled] = yield* settings.get();
              assert.equal(uninstalled?.hasAppToken, false);
              assert.equal(uninstalled?.hasBotToken, false);
            }),
          undefined,
          undefined,
          fixtures,
        );
      }),
  );

  it.effect.each([
    "success",
    "auth_invalid",
    "auth_revoked",
    "network",
    "timeout",
    "rate_limited",
  ] as const)(
    "handles an in-margin event with auth.test %s without deleting credentials",
    (category) =>
      Effect.gen(function* () {
        const baseDir = yield* tempBaseDir;
        const sdk = makeFakeSlackSdk();
        const fixtures = { gateway: makeFakeGateway(), registry: makeFakeTransportRegistry() };
        yield* withServer(
          baseDir,
          sdk,
          (settings) =>
            Effect.gen(function* () {
              const created = yield* createConnected(settings);
              sdk.script.authTest = () =>
                category === "success"
                  ? Promise.resolve({ teamId: "T0TEAM", botUserId: "U0BOT", botId: undefined })
                  : Promise.reject(sdk.failure("auth.test", category));
              const event = revoke(sdk, "app_uninstalled", 100);
              yield* receiveOnlyBarrier(sdk);
              assert.equal(
                event.ackCount(),
                ["success", "auth_invalid", "auth_revoked"].includes(category) ? 1 : 0,
              );
              const [current] = yield* settings.get();
              assert.equal(current?.hasAppToken, true);
              assert.equal(current?.hasBotToken, true);
              assert.equal(current?.status, category === "success" ? "connected" : "error");
              assert(!((yield* fileState(baseDir)).settings ?? "").includes('"revoked"'));
              if (category !== "success") {
                yield* assertBlockedDelivery(fixtures.registry, created.connectionId);
                assert.equal(fixtures.gateway.calls.length, 0);
                assert(!sdk.calls.includes("disconnect:0"));
              }
            }),
          undefined,
          undefined,
          fixtures,
        );
      }),
  );

  it.effect.each(["tokens_revoked", "app_uninstalled"] as const)(
    "ACKs stale %s on a new socket after reconfigure",
    (kind) =>
      Effect.gen(function* () {
        const baseDir = yield* tempBaseDir;
        const sdk = makeFakeSlackSdk();
        yield* withServer(baseDir, sdk, (settings) =>
          Effect.gen(function* () {
            const created = yield* createConnected(settings);
            yield* TestClock.adjust("20 seconds");
            yield* settings.configure({
              connectionId: created.connectionId,
              enabled: true,
              appToken: "xapp-replacement",
              botToken: "xoxb-replacement",
            });
            yield* awaitConnected(settings);
            const filesBefore = yield* fileState(baseDir);
            yield* Effect.promise(() => revoke(sdk, kind, 10).acked);
            const [current] = yield* settings.get();
            assert.equal(current?.status, "connected");
            assert.equal(current?.hasAppToken, true);
            assert.equal(current?.hasBotToken, true);
            assert.equal((yield* fileState(baseDir)).settings, filesBefore.settings);
          }),
        );
      }),
  );

  it.effect(
    "a host clock ten seconds behind replacement never deletes the replacement tokens",
    () =>
      Effect.gen(function* () {
        const baseDir = yield* tempBaseDir;
        const sdk = makeFakeSlackSdk();
        yield* withServer(baseDir, sdk, (settings) =>
          Effect.gen(function* () {
            const created = yield* createConnected(settings);
            yield* TestClock.adjust("20 seconds");
            yield* settings.configure({
              connectionId: created.connectionId,
              enabled: true,
              appToken: "xapp-replacement",
              botToken: "xoxb-replacement",
            });
            yield* awaitConnected(settings);
            // Slack's event at 29 preceded the real replacement at 30; host saved it at 20.
            sdk.script.authTest = () => Promise.reject(sdk.failure("auth.test", "auth_invalid"));
            const before = (yield* fileState(baseDir)).settings;
            yield* Effect.promise(() => revoke(sdk, "app_uninstalled", 29).acked);
            const [current] = yield* settings.get();
            assert.equal(current?.hasAppToken, true);
            assert.equal(current?.hasBotToken, true);
            assert.equal(current?.status, "error");
            assert.equal((yield* fileState(baseDir)).settings, before);
          }),
        );
      }),
  );

  it.effect.each(["bot", "app"] as const)(
    "does not ACK a failed %s secret deletion; restart reapplies the tombstone",
    (token) =>
      Effect.gen(function* () {
        const baseDir = yield* tempBaseDir;
        const sdk = makeFakeSlackSdk();
        const overrides: { current: SecretStoreOverrides } = { current: {} };
        const fixtures = { gateway: makeFakeGateway(), registry: makeFakeTransportRegistry() };
        yield* withServer(
          baseDir,
          sdk,
          (settings) =>
            Effect.gen(function* () {
              const created = yield* createConnected(settings);
              const fs = yield* FileSystem.FileSystem;
              const files = yield* fileState(baseDir);
              overrides.current = {
                remove: (name) =>
                  name ===
                  (token === "bot"
                    ? SlackChannelSettingsLive.botTokenSecretName(created.connectionId)
                    : SlackChannelSettingsLive.appTokenSecretName(created.connectionId))
                    ? Effect.fail(
                        new ServerSecretStore.SecretStorePersistError({
                          resource: "secret",
                          cause: "disk failure",
                        }),
                      )
                    : fs.remove(files.secretPath(name), { force: true }).pipe(Effect.ignore),
              };
              const event = revoke(sdk, "app_uninstalled");
              yield* receiveOnlyBarrier(sdk);
              assert.equal(event.ackCount(), 0);
              assert(!sdk.calls.includes("disconnect:0"));
              yield* assertBlockedDelivery(fixtures.registry, created.connectionId);
              assert((yield* fileState(baseDir)).settings?.includes('"revoked":"app_uninstalled"'));
            }),
          overrides,
          undefined,
          fixtures,
        );
        overrides.current = {};
        const restarted = makeFakeSlackSdk();
        yield* withServer(baseDir, restarted, (settings) =>
          Effect.gen(function* () {
            const [current] = yield* settings.get();
            assert.equal(current?.hasAppToken, false);
            assert.equal(current?.hasBotToken, false);
            assert.equal(current?.lastError, "app_uninstalled");
            assert.equal(restarted.sessions.length, 0);
          }),
        );
      }),
  );

  it.effect(
    "tombstone write failure leaves receive-only without ACK; redelivery completes cleanup",
    () =>
      Effect.gen(function* () {
        const baseDir = yield* tempBaseDir;
        const sdk = makeFakeSlackSdk();
        yield* withServer(baseDir, sdk, (settings) =>
          Effect.gen(function* () {
            yield* createConnected(settings);
            const fs = yield* FileSystem.FileSystem;
            const files = yield* fileState(baseDir);
            yield* fs.rename(files.settingsPath, `${files.settingsPath}.backup`);
            yield* fs.makeDirectory(files.settingsPath);
            const event = revoke(sdk, "app_uninstalled");
            yield* receiveOnlyBarrier(sdk);
            assert.equal(event.ackCount(), 0);
            assert(!sdk.calls.includes("disconnect:0"));
            yield* fs.remove(files.settingsPath, { recursive: true });
            yield* fs.rename(`${files.settingsPath}.backup`, files.settingsPath);
            const [current] = yield* settings.get();
            assert.equal(current?.hasBotToken, true);
            assert.equal(current?.hasAppToken, true);
            assert.equal(current?.status, "error");
            yield* Effect.promise(() => revoke(sdk, "app_uninstalled").acked);
            const [cleaned] = yield* settings.get();
            assert.equal(cleaned?.hasBotToken, false);
            assert.equal(cleaned?.hasAppToken, false);
          }),
        );
      }),
  );

  it.effect(
    "ignores an old-generation callback after configure without touching the new tokens",
    () =>
      Effect.gen(function* () {
        const baseDir = yield* tempBaseDir;
        const sdk = makeFakeSlackSdk();
        const applied: SlackChannelRuntime.SlackRuntimeConnection[] = [];
        yield* withServer(
          baseDir,
          sdk,
          (settings) =>
            Effect.gen(function* () {
              const created = yield* createConnected(settings);
              const old = applied.find((connection) => connection.enabled);
              assert(old?.onRevoked !== undefined);
              yield* settings.configure({
                connectionId: created.connectionId,
                enabled: true,
                botToken: "xoxb-replacement",
              });
              yield* awaitConnected(settings);
              assert.equal(
                yield* old.onRevoked({ kind: "app_uninstalled", eventTime: 1000 }, 1),
                "ignored",
              );
              const [current] = yield* settings.get();
              assert.equal(current?.status, "connected");
              assert.equal(current?.hasAppToken, true);
              assert.equal(current?.hasBotToken, true);
              assert(!((yield* fileState(baseDir)).settings ?? "").includes('"revoked"'));
            }),
          undefined,
          (connection) =>
            Effect.sync(() => {
              applied.push(connection);
            }),
        );
      }),
  );
});

describe("Slack credential generations", () => {
  it.effect("decodes older files without saved times or tombstones", () =>
    Effect.gen(function* () {
      const baseDir = yield* tempBaseDir;
      const sdk = makeFakeSlackSdk();
      yield* withServer(baseDir, sdk, (settings) =>
        Effect.gen(function* () {
          yield* createConnected(settings);
          const fs = yield* FileSystem.FileSystem;
          const files = yield* fileState(baseDir);
          assert(files.settings !== undefined);
          yield* fs.writeFileString(
            files.settingsPath,
            files.settings.replace(/,"(?:app|bot)TokenSavedAt":\d+/g, ""),
          );
        }),
      );
      const restarted = makeFakeSlackSdk();
      yield* withServer(baseDir, restarted, (settings) =>
        Effect.gen(function* () {
          yield* awaitConnected(settings);
          const [current] = yield* settings.get();
          assert.equal(current?.hasAppToken, true);
          assert.equal(current?.hasBotToken, true);
          yield* Effect.promise(() => revoke(restarted, "tokens_revoked").acked);
          const [revoked] = yield* settings.get();
          assert.equal(revoked?.hasBotToken, false);
        }),
      );
    }),
  );

  it.effect(
    "saves disabled timestamps and clears the tombstone before writing replacement secrets",
    () =>
      Effect.gen(function* () {
        const baseDir = yield* tempBaseDir;
        const sdk = makeFakeSlackSdk();
        const overrides: { current: SecretStoreOverrides } = { current: {} };
        yield* withServer(
          baseDir,
          sdk,
          (settings) =>
            Effect.gen(function* () {
              const created = yield* createConnected(settings);
              yield* Effect.promise(() => revoke(sdk, "tokens_revoked").acked);
              const firstFile = (yield* fileState(baseDir)).settings ?? "";
              const firstTime = Number(/"botTokenSavedAt":(\d+)/.exec(firstFile)?.[1]);
              const setEntered = yield* Deferred.make<void>();
              const fs = yield* FileSystem.FileSystem;
              const settingsPath = (yield* fileState(baseDir)).settingsPath;
              overrides.current = {
                set: () =>
                  Effect.gen(function* () {
                    const file = yield* fs.readFileString(settingsPath).pipe(Effect.orDie);
                    assert(file.includes('"enabled":false'));
                    assert(!file.includes('"revoked"'));
                    const secondTime = Number(/"botTokenSavedAt":(\d+)/.exec(file)?.[1]);
                    assert(secondTime > firstTime);
                    yield* Deferred.succeed(setEntered, undefined);
                    return yield* Effect.fail(
                      new ServerSecretStore.SecretStorePersistError({
                        resource: "secret",
                        cause: "write failed",
                      }),
                    );
                  }),
              };
              const failed = yield* Effect.flip(
                settings.configure({
                  connectionId: created.connectionId,
                  enabled: true,
                  botToken: "xoxb-replacement",
                }),
              );
              yield* Deferred.await(setEntered);
              assert.equal(failed.reason, "persistence_failed");
              const [current] = yield* settings.get();
              assert.equal(current?.enabled, false);
              assert.equal(current?.status, "disabled");
              assert.equal(current?.hasBotToken, false);
            }),
          overrides,
        );
      }),
  );

  it.effect(
    "preserves old secrets after replacement write failure and ignores same-period revocation",
    () =>
      Effect.gen(function* () {
        const baseDir = yield* tempBaseDir;
        const sdk = makeFakeSlackSdk();
        const overrides: { current: SecretStoreOverrides } = { current: {} };
        yield* withServer(
          baseDir,
          sdk,
          (settings) =>
            Effect.gen(function* () {
              const created = yield* createConnected(settings);
              yield* TestClock.adjust("20 seconds");
              overrides.current = {
                set: () =>
                  Effect.fail(
                    new ServerSecretStore.SecretStorePersistError({
                      resource: "secret",
                      cause: "disk full",
                    }),
                  ),
              };
              yield* Effect.flip(
                settings.configure({
                  connectionId: created.connectionId,
                  enabled: true,
                  botToken: "xoxb-replacement",
                }),
              );
              const fs = yield* FileSystem.FileSystem;
              const files = yield* fileState(baseDir);
              assert.equal(
                yield* fs.readFileString(
                  files.secretPath(
                    SlackChannelSettingsLive.botTokenSecretName(created.connectionId),
                  ),
                ),
                BOT_TOKEN,
              );
              assert(files.settings?.includes('"botTokenSavedAt":20'));
              overrides.current = {};
              yield* settings.configure({ connectionId: created.connectionId, enabled: true });
              yield* awaitConnected(settings);
              const before = (yield* fileState(baseDir)).settings;
              yield* Effect.promise(() => revoke(sdk, "app_uninstalled", 20).acked);
              const [current] = yield* settings.get();
              assert.equal(current?.hasBotToken, true);
              assert.equal(current?.hasAppToken, true);
              assert.equal((yield* fileState(baseDir)).settings, before);
            }),
          overrides,
        );
      }),
  );

  it.effect(
    "a revocation waiting for the configure lock is interruptible while configure retires its socket",
    () =>
      Effect.gen(function* () {
        const baseDir = yield* tempBaseDir;
        const sdk = makeFakeSlackSdk();
        yield* withServer(baseDir, sdk, (settings) =>
          Effect.gen(function* () {
            const created = yield* createConnected(settings);
            let markValidating!: () => void;
            const validating = new Promise<void>((resolve) => {
              markValidating = resolve;
            });
            let resolveAuth!: () => void;
            sdk.script.authTest = () =>
              new Promise((resolve) => {
                resolveAuth = () =>
                  resolve({ teamId: "T0TEAM", botUserId: "U0BOT", botId: undefined });
                markValidating();
              });
            const configuring = yield* Effect.forkChild(
              settings.configure({
                connectionId: created.connectionId,
                enabled: true,
                botToken: "xoxb-next",
              }),
            );
            yield* Effect.promise(() => validating);
            const event = revoke(sdk, "app_uninstalled");
            yield* settings.streamStatus().pipe(
              Stream.filter((status) => status.status === "error"),
              Stream.runHead,
            );
            resolveAuth();
            sdk.script.authTest = () =>
              Promise.resolve({ teamId: "T0TEAM", botUserId: "U0BOT", botId: undefined });
            yield* Fiber.join(configuring);
            yield* awaitConnected(settings);
            assert.equal(event.ackCount(), 0);
            const [current] = yield* settings.get();
            assert.equal(current?.hasAppToken, true);
            assert.equal(current?.hasBotToken, true);
            assert(!((yield* fileState(baseDir)).settings ?? "").includes('"revoked"'));
          }),
        );
      }),
  );
});

describe("Slack revocation recovery", () => {
  it.effect.each(["bot", "app"] as const)(
    "redelivery retries a failed %s deletion before ACK",
    (token) =>
      Effect.gen(function* () {
        const baseDir = yield* tempBaseDir;
        const sdk = makeFakeSlackSdk();
        const overrides: { current: SecretStoreOverrides } = { current: {} };
        yield* withServer(
          baseDir,
          sdk,
          (settings) =>
            Effect.gen(function* () {
              yield* createConnected(settings);
              overrides.current = {
                remove: () =>
                  Effect.fail(
                    new ServerSecretStore.SecretStorePersistError({
                      resource: "secret",
                      cause: "disk error",
                    }),
                  ),
              };
              const kind = token === "bot" ? "tokens_revoked" : "app_uninstalled";
              const first = revoke(sdk, kind);
              yield* receiveOnlyBarrier(sdk);
              assert.equal(first.ackCount(), 0);
              overrides.current = {};
              yield* Effect.promise(() => revoke(sdk, kind).acked);
              const [current] = yield* settings.get();
              assert.equal(current?.hasBotToken, false);
              assert.equal(current?.hasAppToken, token === "bot");
            }),
          overrides,
        );
      }),
  );

  it.effect.each(["auth_invalid", "auth_revoked"] as const)(
    "startup authentication failure %s leaves both secrets intact",
    (category) =>
      Effect.gen(function* () {
        const baseDir = yield* tempBaseDir;
        yield* withServer(baseDir, makeFakeSlackSdk(), (settings) =>
          Effect.asVoid(createConnected(settings)),
        );
        const sdk = makeFakeSlackSdk();
        sdk.script.authTest = () => Promise.reject(sdk.failure("auth.test", category));
        yield* withServer(baseDir, sdk, (settings) =>
          Effect.gen(function* () {
            yield* settings.streamStatus().pipe(
              Stream.filter((status) => status.status === "error"),
              Stream.runHead,
            );
            yield* TestClock.adjust("10 minutes");
            const [current] = yield* settings.get();
            assert.equal(current?.hasAppToken, true);
            assert.equal(current?.hasBotToken, true);
            assert.equal(sdk.sessions.length, 0);
            assert.equal(sdk.calls.filter((call) => call === "authTest").length, 1);
          }),
        );
      }),
  );

  it.effect("applies an uninstall inside the margin once the bot token is already revoked", () =>
    Effect.gen(function* () {
      const baseDir = yield* tempBaseDir;
      const sdk = makeFakeSlackSdk();
      yield* withServer(baseDir, sdk, (settings) =>
        Effect.gen(function* () {
          yield* createConnected(settings);
          yield* Effect.promise(() => revoke(sdk, "tokens_revoked").acked);
          const authCalls = sdk.calls.filter((call) => call === "authTest").length;
          // Within five minutes of the saved tokens; the tombstone already proves the bot is dead.
          yield* Effect.promise(() => revoke(sdk, "app_uninstalled", 100).acked);
          const [current] = yield* settings.get();
          assert.equal(current?.hasAppToken, false);
          assert.equal(current?.hasBotToken, false);
          assert.equal(sdk.calls.filter((call) => call === "authTest").length, authCalls);
          assert((yield* fileState(baseDir)).settings?.includes('"revoked":"app_uninstalled"'));
        }),
      );
    }),
  );

  it.effect("applies revocation at savedAt plus 300 seconds without reauthenticating", () =>
    Effect.gen(function* () {
      const baseDir = yield* tempBaseDir;
      const sdk = makeFakeSlackSdk();
      yield* withServer(baseDir, sdk, (settings) =>
        Effect.gen(function* () {
          yield* createConnected(settings);
          const authCalls = sdk.calls.filter((call) => call === "authTest").length;
          yield* Effect.promise(() => revoke(sdk, "tokens_revoked", 301).acked);
          const [current] = yield* settings.get();
          assert.equal(current?.hasBotToken, false);
          assert.equal(current?.hasAppToken, true);
          assert.equal(sdk.calls.filter((call) => call === "authTest").length, authCalls);
        }),
      );
    }),
  );
});

describe("Slack bot tombstone recovery", () => {
  it.effect(
    "reapplies bot deletion after a crash between tombstone persistence and secret cleanup",
    () =>
      Effect.gen(function* () {
        const baseDir = yield* tempBaseDir;
        const sdk = makeFakeSlackSdk();
        const overrides: { current: SecretStoreOverrides } = { current: {} };
        yield* withServer(
          baseDir,
          sdk,
          (settings) =>
            Effect.gen(function* () {
              yield* createConnected(settings);
              overrides.current = {
                remove: () =>
                  Effect.fail(
                    new ServerSecretStore.SecretStorePersistError({
                      resource: "secret",
                      cause: "crash before deletion",
                    }),
                  ),
              };
              const event = revoke(sdk, "tokens_revoked");
              yield* receiveOnlyBarrier(sdk);
              assert.equal(event.ackCount(), 0);
              const [current] = yield* settings.get();
              assert.equal(current?.hasBotToken, true);
              assert((yield* fileState(baseDir)).settings?.includes('"revoked":"bot_revoked"'));
            }),
          overrides,
        );
        const restarted = makeFakeSlackSdk();
        const fixtures = { gateway: makeFakeGateway(), registry: makeFakeTransportRegistry() };
        yield* withServer(
          baseDir,
          restarted,
          (settings) =>
            Effect.gen(function* () {
              yield* Effect.promise(() => restarted.waitForCall("start:0"));
              yield* receiveOnlyBarrier(restarted);
              const [current] = yield* settings.get();
              assert(current !== undefined);
              assert.equal(current.hasAppToken, true);
              assert.equal(current.hasBotToken, false);
              assert.equal(current.lastError, "token_revoked");
              yield* assertBlockedDelivery(fixtures.registry, current.connectionId);
              assert.equal(restarted.calls.filter((call) => call === "authTest").length, 0);
              assert.equal(fixtures.gateway.calls.length, 0);
            }),
          undefined,
          undefined,
          fixtures,
        );
      }),
  );

  it.effect(
    "clearCredentials removes a persisted revocation tombstone and both saved timestamps",
    () =>
      Effect.gen(function* () {
        const baseDir = yield* tempBaseDir;
        const sdk = makeFakeSlackSdk();
        yield* withServer(baseDir, sdk, (settings) =>
          Effect.gen(function* () {
            const created = yield* createConnected(settings);
            yield* Effect.promise(() => revoke(sdk, "tokens_revoked").acked);
            const before = (yield* fileState(baseDir)).settings ?? "";
            assert(before.includes('"revoked":"bot_revoked"'));
            assert(before.includes("appTokenSavedAt"));
            assert(before.includes("botTokenSavedAt"));
            const cleared = yield* settings.configure({
              connectionId: created.connectionId,
              enabled: false,
              clearCredentials: true,
            });
            assert.equal(cleared.status, "disabled");
            assert.equal(cleared.hasAppToken, false);
            assert.equal(cleared.hasBotToken, false);
            const after = (yield* fileState(baseDir)).settings ?? "";
            assert(!after.includes('"revoked"'));
            assert(!after.includes("SavedAt"));
          }),
        );
      }),
  );
});

describe("Slack home ownership", () => {
  it.effect("saves on a non-home server and opens and stops sockets only on home flips", () =>
    Effect.gen(function* () {
      const baseDir = yield* tempBaseDir;
      const sdk = makeFakeSlackSdk();
      const self = EnvironmentId.make("environment:slack-test");
      const other = EnvironmentId.make("environment:other-home");
      const claim = (environmentId: EnvironmentId, claimedAt: number) => ({
        environmentId,
        claimedAt,
        claimId: "home-" + claimedAt,
      });
      const layer = PublishingServerSettings.layer({ goatBotHome: claim(other, 1) });
      yield* withServer(
        baseDir,
        sdk,
        (settings) =>
          Effect.gen(function* () {
            const serverSettings = yield* ServerSettings.ServerSettingsService;
            const created = yield* settings.configure(
              { enabled: true, appToken: APP_TOKEN, botToken: BOT_TOKEN },
              owner,
            );
            assert.isTrue(created.enabled);
            assert.strictEqual(sdk.sessions.length, 0);
            yield* serverSettings.updateSettings({ goatBotHome: claim(self, 2) });
            yield* Effect.promise(() => sdk.waitForCall("start:0"));
            yield* awaitConnected(settings);
            assert.strictEqual(sdk.sessions.length, 1);
            // A change with the same eligibility must not reopen a socket.
            yield* serverSettings.updateSettings({ goatBotHome: claim(self, 3) });
            yield* serverSettings.updateSettings({ goatBotHome: claim(other, 4) });
            yield* Effect.promise(() => sdk.waitForCall("disconnect:0"));
            const [saved] = yield* settings.get();
            assert.isTrue(saved?.enabled);
            const files = yield* fileState(baseDir);
            assert.isTrue(JSON.parse(files.settings!).connections[0].enabled);
            yield* settings.configure(
              {
                connectionId: created.connectionId,
                enabled: true,
                allowedChannelIds: ["C0ALLOWED"],
              },
              owner,
            );
            assert.strictEqual(sdk.sessions.length, 1);
            yield* serverSettings.updateSettings({ goatBotHome: claim(self, 5) });
            yield* Effect.promise(() => sdk.waitForCall("start:1"));
            yield* awaitConnected(settings);
            assert.strictEqual(sdk.sessions.length, 2);
          }),
        undefined,
        undefined,
        undefined,
        layer,
      );
      // A restart off-home retains enabled but does not recreate the socket.
      yield* withServer(
        baseDir,
        sdk,
        (settings) =>
          Effect.gen(function* () {
            assert.isTrue((yield* settings.get())[0]?.enabled);
            assert.strictEqual(sdk.sessions.length, 2);
          }),
        undefined,
        undefined,
        undefined,
        PublishingServerSettings.layer({ goatBotHome: claim(other, 6) }),
      );
    }),
  );

  it.effect("stops a socket opened before another connection failed when home moves away", () =>
    Effect.gen(function* () {
      const baseDir = yield* tempBaseDir;
      const sdk = makeFakeSlackSdk();
      const overrides: { current: SecretStoreOverrides } = { current: {} };
      const self = EnvironmentId.make("environment:slack-test");
      const other = EnvironmentId.make("environment:other-home");
      const claim = (environmentId: EnvironmentId, claimedAt: number) => ({
        environmentId,
        claimedAt,
        claimId: "home-" + claimedAt,
      });
      yield* withServer(
        baseDir,
        sdk,
        (settings) =>
          Effect.gen(function* () {
            const serverSettings = yield* ServerSettings.ServerSettingsService;
            yield* settings.configure(
              { enabled: true, appToken: APP_TOKEN, botToken: BOT_TOKEN },
              owner,
            );
            const broken = yield* settings.configure(
              { enabled: true, appToken: APP_TOKEN, botToken: BOT_TOKEN },
              owner,
            );
            assert.strictEqual(sdk.sessions.length, 0);
            const brokenSecret = SlackChannelSettingsLive.appTokenSecretName(broken.connectionId);
            overrides.current = { unreadable: (name) => name === brokenSecret };
            yield* serverSettings.updateSettings({ goatBotHome: claim(self, 2) });
            yield* Effect.promise(() => sdk.waitForCall("start:0"));
            yield* serverSettings.updateSettings({ goatBotHome: claim(other, 3) });
            yield* Effect.promise(() => sdk.waitForCall("disconnect:0"));
          }),
        overrides,
        undefined,
        undefined,
        PublishingServerSettings.layer({ goatBotHome: claim(other, 1) }),
      );
    }),
  );

  it.effect("stops a socket configure opened while home came and went under its lock", () =>
    Effect.gen(function* () {
      const baseDir = yield* tempBaseDir;
      const sdk = makeFakeSlackSdk();
      const overrides: { current: SecretStoreOverrides } = { current: {} };
      const moveAway: { current: Effect.Effect<void> } = { current: Effect.void };
      const self = EnvironmentId.make("environment:slack-test");
      const other = EnvironmentId.make("environment:other-home");
      const claim = (environmentId: EnvironmentId, claimedAt: number) => ({
        environmentId,
        claimedAt,
        claimId: "home-" + claimedAt,
      });
      yield* withServer(
        baseDir,
        sdk,
        (settings) =>
          Effect.gen(function* () {
            const serverSettings = yield* ServerSettings.ServerSettingsService;
            let movedHere = false;
            // Home arrives while configure holds the lock, so the watcher's pass waits behind it.
            overrides.current = {
              beforeSet: () =>
                movedHere
                  ? Effect.void
                  : Effect.sync(() => {
                      movedHere = true;
                    }).pipe(
                      Effect.andThen(
                        serverSettings.updateSettings({ goatBotHome: claim(self, 2) }),
                      ),
                      Effect.asVoid,
                      Effect.orDie,
                    ),
            };
            // ...and leaves again once configure has opened the socket, still under the lock.
            moveAway.current = serverSettings
              .updateSettings({ goatBotHome: claim(other, 3) })
              .pipe(Effect.asVoid, Effect.orDie);
            yield* settings.configure(
              { enabled: true, appToken: APP_TOKEN, botToken: BOT_TOKEN },
              owner,
            );
            yield* Effect.promise(() => sdk.waitForCall("start:0"));
            yield* Effect.promise(() => sdk.waitForCall("disconnect:0"));
          }),
        overrides,
        (connection) => {
          if (connection.appToken === undefined) return Effect.void;
          const move = moveAway.current;
          moveAway.current = Effect.void;
          return move;
        },
        undefined,
        PublishingServerSettings.layer({ goatBotHome: claim(other, 1) }),
      );
    }),
  );
});
