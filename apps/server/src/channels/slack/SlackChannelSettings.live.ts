/**
 * Live implementation of the SlackChannelSettings port.
 *
 * Tokens live in the server secret store (`slack-<connectionId>-app-token` and
 * `-bot-token`) and never leave it through this service. Everything else about a connection,
 * including the host owner it acts for, is kept in `<stateDir>/slack-channel-settings.json`.
 *
 * Changes that touch credentials save the connection as disabled first and stop its socket,
 * so a crash part-way through leaves a disabled connection rather than one running on half a
 * credential change.
 *
 * @module SlackChannelSettings.live
 */
import {
  AuthEnvironmentScopes,
  RuntimeMode,
  SlackChannelConnectionId,
  SlackChannelDefaultTarget,
  SlackChannelSettingsError,
  TrimmedNonEmptyString,
  type SlackChannelConfigureInput,
  type SlackChannelSettings as SlackChannelSettingsSnapshot,
  type SlackChannelSettingsErrorReason,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as SlackChannelSettings from "../SlackChannelSettings.ts";
import type { SlackConnectionOwner } from "./SlackChannelAdapter.ts";
import * as SlackChannelRuntime from "./SlackChannelRuntime.ts";
import * as SlackSdk from "./SlackSdk.ts";

const StoredOwner = Schema.Struct({
  ownerId: TrimmedNonEmptyString,
  principalId: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  grantedScopes: AuthEnvironmentScopes,
  runtimeModeCeiling: RuntimeMode,
});

const StoredConnection = Schema.Struct({
  connectionId: SlackChannelConnectionId,
  enabled: Schema.Boolean,
  teamId: Schema.optional(TrimmedNonEmptyString),
  botUserId: Schema.optional(TrimmedNonEmptyString),
  allowedChannelIds: Schema.Array(TrimmedNonEmptyString),
  defaultTarget: Schema.optional(SlackChannelDefaultTarget),
  owner: Schema.optional(StoredOwner),
});
type StoredConnection = typeof StoredConnection.Type;

const SettingsFile = Schema.Struct({
  version: Schema.Literal(1),
  connections: Schema.Array(StoredConnection),
});
const SettingsFileJson = Schema.fromJsonString(SettingsFile);
const decodeSettingsFile = Schema.decodeUnknownEffect(SettingsFileJson);
const encodeSettingsFile = Schema.encodeEffect(SettingsFileJson);

const SETTINGS_FILE_NAME = "slack-channel-settings.json";
/** Server-generated connection ids. Only these are ever used in secret file names. */
const CONNECTION_ID_PATTERN = /^slack-[a-f0-9]{12}$/;

export const appTokenSecretName = (connectionId: string) => `slack-${connectionId}-app-token`;
export const botTokenSecretName = (connectionId: string) => `slack-${connectionId}-bot-token`;

const fail = (reason: SlackChannelSettingsErrorReason) =>
  Effect.fail(new SlackChannelSettingsError({ reason }));

/** Logs the underlying failure by category only and reports `persistence_failed`. */
const persistenceFailed = (stage: string) => (cause: unknown) =>
  Effect.logWarning("Slack settings could not be saved or read.").pipe(
    Effect.annotateLogs({
      stage,
      errorTag:
        typeof cause === "object" && cause !== null && "_tag" in cause
          ? String(cause._tag)
          : "unknown",
    }),
    Effect.andThen(fail("persistence_failed")),
  );

const tokenValidationFailed = (failure: SlackSdk.SlackSdkFailure) =>
  fail(
    failure.category === "auth_revoked" || failure.category === "auth_invalid"
      ? "invalid_token"
      : "adapter_unavailable",
  );

interface State {
  readonly loadFailed: boolean;
  readonly connections: ReadonlyArray<StoredConnection>;
}

/** The implementation, whose `configure` already takes the trusted owner. */
export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig.ServerConfig;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const sdk = yield* SlackSdk.SlackSdk;
  const runtime = yield* SlackChannelRuntime.SlackChannelRuntime;
  const settingsPath = path.join(config.stateDir, SETTINGS_FILE_NAME);
  const lock = yield* Semaphore.make(1);

  const loaded = yield* Effect.gen(function* () {
    if (!(yield* fs.exists(settingsPath))) return { loadFailed: false, connections: [] };
    const file = yield* decodeSettingsFile(yield* fs.readFileString(settingsPath));
    return { loadFailed: false, connections: file.connections };
  }).pipe(
    Effect.catch(() =>
      // Keep a damaged file as it is; every operation reports the failure until it is fixed.
      Effect.logError("Slack settings file could not be read; Slack stays off.").pipe(
        Effect.as<State>({ loadFailed: true, connections: [] }),
      ),
    ),
  );
  const state = yield* Ref.make<State>(loaded);

  const readConnections = Effect.flatMap(Ref.get(state), (current) =>
    current.loadFailed ? fail("persistence_failed") : Effect.succeed(current.connections),
  );

  /** Writes a private temporary file and renames it over the settings file. */
  const writeConnections = (connections: ReadonlyArray<StoredConnection>) =>
    Effect.gen(function* () {
      const contents = yield* encodeSettingsFile({ version: 1, connections });
      const tempPath = `${settingsPath}.${yield* crypto.randomUUIDv4}.tmp`;
      yield* fs.makeDirectory(config.stateDir, { recursive: true });
      yield* Effect.gen(function* () {
        yield* fs.writeFileString(tempPath, `${contents}\n`, { mode: 0o600 });
        yield* fs.chmod(tempPath, 0o600);
        yield* fs.rename(tempPath, settingsPath);
      }).pipe(Effect.onError(() => fs.remove(tempPath).pipe(Effect.ignore)));
      yield* Ref.set(state, { loadFailed: false, connections });
    }).pipe(Effect.catch(persistenceFailed("write-settings")));

  const saveConnection = (connection: StoredConnection) =>
    Effect.flatMap(readConnections, (connections) => {
      const index = connections.findIndex((c) => c.connectionId === connection.connectionId);
      const next =
        index === -1
          ? [...connections, connection]
          : connections.map((c, i) => (i === index ? connection : c));
      return writeConnections(next);
    });

  const readSecret = (name: string) =>
    secrets
      .get(name)
      .pipe(
        Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes))),
        Effect.catch(persistenceFailed("read-secret")),
      );
  const hasSecret = (name: string) => Effect.map(readSecret(name), Option.isSome);

  const runtimeConnection = (connection: StoredConnection) =>
    Effect.gen(function* () {
      const appToken = yield* readSecret(appTokenSecretName(connection.connectionId));
      const botToken = yield* readSecret(botTokenSecretName(connection.connectionId));
      return {
        connectionId: connection.connectionId,
        enabled: connection.enabled,
        allowedChannelIds: connection.allowedChannelIds,
        appToken: Option.getOrUndefined(appToken),
        botToken: Option.getOrUndefined(botToken),
        expectedTeamId: connection.teamId,
        owner: connection.owner,
      } satisfies SlackChannelRuntime.SlackRuntimeConnection;
    });

  const applyToRuntime = (connection: StoredConnection) =>
    connection.enabled
      ? Effect.flatMap(runtimeConnection(connection), runtime.apply)
      : stopRuntime(connection);

  /** Stops a connection without touching its credentials, so stopping cannot fail on them. */
  const stopRuntime = (connection: StoredConnection) =>
    runtime.apply({
      connectionId: connection.connectionId,
      enabled: false,
      allowedChannelIds: connection.allowedChannelIds,
      appToken: undefined,
      botToken: undefined,
      expectedTeamId: connection.teamId,
      owner: connection.owner,
    });

  /**
   * Saves the connection as disabled and stops it as one step: once the disabled state is on
   * disk, an interruption cannot leave the old socket running.
   */
  const disable = (connection: StoredConnection) =>
    Effect.uninterruptible(
      saveConnection({ ...connection, enabled: false }).pipe(
        Effect.andThen(stopRuntime(connection)),
      ),
    );

  const snapshot = (connection: StoredConnection) =>
    Effect.gen(function* () {
      const status = yield* runtime.status(connection.connectionId);
      return {
        connectionId: connection.connectionId,
        enabled: connection.enabled,
        hasAppToken: yield* hasSecret(appTokenSecretName(connection.connectionId)),
        hasBotToken: yield* hasSecret(botTokenSecretName(connection.connectionId)),
        ...(connection.teamId === undefined ? {} : { teamId: connection.teamId }),
        ...(connection.botUserId === undefined ? {} : { botUserId: connection.botUserId }),
        allowedChannelIds: connection.allowedChannelIds,
        ...(connection.defaultTarget === undefined
          ? {}
          : { defaultTarget: connection.defaultTarget }),
        status: status.status,
        ...(status.lastError === undefined ? {} : { lastError: status.lastError }),
        ...(status.lastDeliveryError === undefined
          ? {}
          : { lastDeliveryError: status.lastDeliveryError }),
      } satisfies SlackChannelSettingsSnapshot;
    });

  const findConnection = (connectionId: string) =>
    Effect.flatMap(readConnections, (connections) => {
      const found = CONNECTION_ID_PATTERN.test(connectionId)
        ? connections.find((c) => c.connectionId === connectionId)
        : undefined;
      return found === undefined ? fail("not_found") : Effect.succeed(found);
    });

  const newConnectionId = crypto.randomUUIDv4.pipe(
    Effect.map((uuid) =>
      SlackChannelConnectionId.make(`slack-${uuid.replaceAll("-", "").slice(0, 12)}`),
    ),
    Effect.catch(persistenceFailed("generate-id")),
  );

  /** Disables and stops the connection before its credentials change. */
  const stopForCredentialChange = disable;

  const clearCredentials = (connection: StoredConnection) =>
    Effect.gen(function* () {
      yield* stopForCredentialChange(connection);
      yield* secrets
        .remove(appTokenSecretName(connection.connectionId))
        .pipe(Effect.catch(persistenceFailed("remove-secret")));
      yield* secrets
        .remove(botTokenSecretName(connection.connectionId))
        .pipe(Effect.catch(persistenceFailed("remove-secret")));
      const { teamId: _teamId, botUserId: _botUserId, ...rest } = connection;
      const cleared: StoredConnection = { ...rest, enabled: false };
      yield* disable(cleared);
      return cleared;
    });

  /**
   * `owner` is the authenticated host owner from the RPC session. It is required to create a
   * connection; an existing connection keeps its stored owner when none is given.
   */
  const configure = (input: SlackChannelConfigureInput, owner?: SlackConnectionOwner) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const existing =
          input.connectionId === undefined ? undefined : yield* findConnection(input.connectionId);
        const resolvedOwner = owner ?? existing?.owner;
        if (resolvedOwner === undefined) return yield* fail("invalid_input");
        const connectionId = existing?.connectionId ?? (yield* newConnectionId);
        const base: StoredConnection = existing ?? {
          connectionId,
          enabled: false,
          allowedChannelIds: [],
        };

        if (input.clearCredentials === true) {
          if (input.appToken !== undefined || input.botToken !== undefined) {
            return yield* fail("invalid_input");
          }
          return yield* snapshot(yield* clearCredentials(base));
        }

        // Validate new tokens before anything is written.
        if (input.appToken !== undefined) {
          const appToken = input.appToken;
          yield* SlackSdk.slackCall("apps.connections.open", () =>
            sdk.appApi({ appToken }).openConnection(),
          ).pipe(Effect.catch(tokenValidationFailed));
        }
        let identity: SlackSdk.SlackAuthIdentity | undefined;
        if (input.botToken !== undefined) {
          const botToken = input.botToken;
          identity = yield* SlackSdk.slackCall("auth.test", () =>
            sdk.botApi({ botToken }).authTest(),
          ).pipe(Effect.catch(tokenValidationFailed));
          if (base.teamId !== undefined && identity.teamId !== base.teamId) {
            return yield* fail("invalid_token");
          }
        }

        const hasAppToken =
          input.appToken !== undefined || (yield* hasSecret(appTokenSecretName(connectionId)));
        const hasBotToken =
          input.botToken !== undefined || (yield* hasSecret(botTokenSecretName(connectionId)));
        if (input.enabled && !(hasAppToken && hasBotToken)) return yield* fail("invalid_input");

        if (input.appToken !== undefined || input.botToken !== undefined) {
          yield* stopForCredentialChange(base);
          if (input.appToken !== undefined) {
            yield* secrets
              .set(appTokenSecretName(connectionId), new TextEncoder().encode(input.appToken))
              .pipe(Effect.catch(persistenceFailed("write-secret")));
          }
          if (input.botToken !== undefined) {
            yield* secrets
              .set(botTokenSecretName(connectionId), new TextEncoder().encode(input.botToken))
              .pipe(Effect.catch(persistenceFailed("write-secret")));
          }
        }

        const next: StoredConnection = {
          ...base,
          enabled: input.enabled,
          ...(identity === undefined
            ? {}
            : { teamId: identity.teamId, botUserId: identity.botUserId }),
          allowedChannelIds: input.allowedChannelIds ?? base.allowedChannelIds,
          ...(input.defaultTarget === undefined ? {} : { defaultTarget: input.defaultTarget }),
          owner: resolvedOwner,
        };
        if (next.enabled) {
          yield* saveConnection(next);
          yield* applyToRuntime(next);
        } else {
          yield* disable(next);
        }
        return yield* snapshot(next);
      }),
    );

  const service = SlackChannelSettings.SlackChannelSettings.of({
    get: () =>
      Effect.flatMap(readConnections, (connections) => Effect.forEach(connections, snapshot)),
    configure,
    disconnect: ({ connectionId }) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          yield* disable(yield* findConnection(connectionId));
        }),
      ),
    streamStatus: () => Stream.unwrap(Effect.as(readConnections, runtime.streamStatus)),
  });

  // Bring saved connections back up. A connection whose secrets cannot be read starts in error.
  if (!loaded.loadFailed) {
    yield* Effect.forEach(loaded.connections, (connection) =>
      applyToRuntime(connection).pipe(Effect.ignore({ log: true })),
    );
  }

  return { ...service, configure };
});

export const layer = Layer.effect(SlackChannelSettings.SlackChannelSettings, make);
