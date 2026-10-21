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
  SlackChannelReviewSettings,
  SlackChannelSettingsError,
  TrimmedNonEmptyString,
  type SlackChannelConfigureInput,
  type SlackChannelSettings as SlackChannelSettingsSnapshot,
  type SlackChannelSettingsErrorReason,
} from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
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
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { isGoatBotHome } from "../ChannelBotHome.ts";
import * as SlackChannelSettings from "../SlackChannelSettings.ts";
import type { ChannelConnectionOwner } from "../ChannelIngressContext.ts";
import * as SlackChannelRuntime from "./SlackChannelRuntime.ts";
import type { SlackRevocationEvent } from "./slackEventMapping.ts";
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
  appTokenSavedAt: Schema.optional(Schema.Number),
  botTokenSavedAt: Schema.optional(Schema.Number),
  revoked: Schema.optional(Schema.Literals(["bot_revoked", "app_uninstalled"])),
  allowedChannelIds: Schema.Array(TrimmedNonEmptyString),
  defaultTarget: Schema.optional(SlackChannelDefaultTarget),
  review: Schema.optional(SlackChannelReviewSettings),
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

const REVOCATION_SKEW_MARGIN_SECONDS = 300;
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
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* environment.getEnvironmentId;
  // Subscribe before reading startup state so a home move during acquisition is replayed.
  const settingsChanges = yield* serverSettings.subscribeChanges;
  const readHome = serverSettings.getSettings.pipe(
    Effect.map((settings) => isGoatBotHome(settings.goatBotHome, environmentId)),
    Effect.catch(persistenceFailed("read-bot-home")),
  );
  const settingsPath = path.join(config.stateDir, SETTINGS_FILE_NAME);
  const lock = yield* Semaphore.make(1);
  // The home role the runtime fully reflects, or null when unknown: after a partial apply, or once
  // configure has applied a connection against a home read that may since have changed. Null makes
  // the next settings change apply again; leaving home always stops every connection.
  let appliedHome: boolean | null = null;

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
      const tempPath = `${settingsPath}.${yield* crypto.randomUUIDv4()}.tmp`;
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
        ...(connection.botUserId === undefined ? {} : { botUserId: connection.botUserId }),
        ...(connection.revoked === undefined ? {} : { revoked: connection.revoked }),
        onRevoked: (event, generation) => onRevoked(connection.connectionId, event, generation),
      } satisfies SlackChannelRuntime.SlackRuntimeConnection;
    });

  const applyForHome = (connection: StoredConnection, isHome: boolean) =>
    connection.enabled && isHome
      ? Effect.flatMap(runtimeConnection(connection), runtime.apply)
      : stopRuntime(connection);

  const applyToRuntime = (connection: StoredConnection) =>
    Effect.flatMap(readHome, (isHome) => applyForHome(connection, isHome)).pipe(
      // Configure applied one connection on its own read of the home; the cache no longer covers it.
      Effect.ensuring(
        Effect.sync(() => {
          appliedHome = null;
        }),
      ),
    );

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
        ...(connection.review === undefined ? {} : { review: connection.review }),
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

  const deleteRevokedSecrets = (connection: StoredConnection) =>
    Effect.gen(function* () {
      if (connection.revoked === undefined) return;
      yield* secrets
        .remove(botTokenSecretName(connection.connectionId))
        .pipe(Effect.catch(persistenceFailed("remove-bot-secret")));
      if (connection.revoked === "app_uninstalled") {
        yield* secrets
          .remove(appTokenSecretName(connection.connectionId))
          .pipe(Effect.catch(persistenceFailed("remove-app-secret")));
      }
    });

  // Acquire interruptibly: configure may be waiting for this handler's socket to stop.
  // Once acquired, persist the tombstone and deletion together without calling runtime.apply.
  const onRevoked = (connectionId: string, event: SlackRevocationEvent, generation: number) =>
    lock.withPermits(1)(
      Effect.uninterruptible(
        Effect.gen(function* () {
          if (!(yield* runtime.isCurrent(connectionId, generation))) return "ignored" as const;
          const connection = yield* findConnection(connectionId);
          const savedAt =
            event.kind === "tokens_revoked"
              ? (connection.botTokenSavedAt ?? 0)
              : Math.max(connection.appTokenSavedAt ?? 0, connection.botTokenSavedAt ?? 0);
          if (event.eventTime < savedAt) return "stale" as const;
          // More than five minutes of clock skew can still misidentify an old installation's
          // event and delete replacement tokens; recovery requires entering the tokens again.
          if (
            // A stored tombstone already proves the bot token is dead, so only a live connection
            // needs auth.test to tell an old event from a current one.
            event.eventTime < savedAt + REVOCATION_SKEW_MARGIN_SECONDS &&
            connection.revoked === undefined
          ) {
            const token = yield* readSecret(botTokenSecretName(connectionId));
            if (Option.isNone(token)) return "blocked" as const;
            const result = yield* Effect.exit(
              SlackSdk.slackCall("auth.test", () =>
                sdk.botApi({ botToken: token.value }).authTest(),
              ),
            );
            if (Exit.isSuccess(result)) {
              return connection.revoked === undefined &&
                result.value.teamId === connection.teamId &&
                result.value.botUserId === connection.botUserId
                ? ("active" as const)
                : ("blocked" as const);
            }
            const error = Exit.findErrorOption(result);
            if (
              Option.isSome(error) &&
              (error.value.category === "auth_revoked" || error.value.category === "auth_invalid")
            )
              return "blocked" as const;
            return yield* fail("adapter_unavailable");
          }
          const revoked =
            connection.revoked === "app_uninstalled" || event.kind === "app_uninstalled"
              ? ("app_uninstalled" as const)
              : ("bot_revoked" as const);
          const next = { ...connection, revoked };
          yield* saveConnection(next);
          yield* deleteRevokedSecrets(next);
          return revoked === "app_uninstalled" ? ("uninstalled" as const) : ("blocked" as const);
        }),
      ),
    );

  const newConnectionId = crypto.randomUUIDv4().pipe(
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
      const {
        teamId: _teamId,
        botUserId: _botUserId,
        revoked: _revoked,
        appTokenSavedAt: _appTokenSavedAt,
        botTokenSavedAt: _botTokenSavedAt,
        ...rest
      } = connection;
      const cleared: StoredConnection = { ...rest, enabled: false };
      yield* disable(cleared);
      return cleared;
    });

  /**
   * `owner` is the authenticated host owner from the RPC session. It is required to create a
   * connection; an existing connection keeps its stored owner when none is given.
   */
  const configure = (input: SlackChannelConfigureInput, owner?: ChannelConnectionOwner) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const existing =
          input.connectionId === undefined ? undefined : yield* findConnection(input.connectionId);
        const resolvedOwner = owner ?? existing?.owner;
        if (resolvedOwner === undefined) return yield* fail("invalid_input");
        const connectionId = existing?.connectionId ?? (yield* newConnectionId);
        let base: StoredConnection = existing ?? {
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
        if (
          input.enabled &&
          !(
            hasAppToken &&
            (hasBotToken ||
              (base.revoked === "bot_revoked" &&
                input.appToken === undefined &&
                input.botToken === undefined))
          )
        )
          return yield* fail("invalid_input");

        if (input.appToken !== undefined || input.botToken !== undefined) {
          const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
          const { revoked: _revoked, ...kept } = base;
          base = {
            ...kept,
            enabled: false,
            ...(input.appToken === undefined
              ? {}
              : { appTokenSavedAt: Math.max(now, (base.appTokenSavedAt ?? 0) + 1) }),
            ...(input.botToken === undefined
              ? {}
              : { botTokenSavedAt: Math.max(now, (base.botTokenSavedAt ?? 0) + 1) }),
          };
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
          ...(input.review === undefined ? {} : { review: input.review }),
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
    defaultTarget: (connectionId) =>
      Effect.map(readConnections, (connections) =>
        Option.fromNullishOr(
          connections.find((connection) => connection.connectionId === connectionId)?.defaultTarget,
        ),
      ),
  });

  /**
   * Applies every saved connection for the given home role, one at a time so one unreadable
   * connection cannot stop the rest. Returns whether all of them applied.
   */
  const applyAllForHome = (
    connections: ReadonlyArray<StoredConnection>,
    isHome: boolean,
    prepare: (connection: StoredConnection) => Effect.Effect<void> = () => Effect.void,
  ) =>
    Effect.map(
      Effect.forEach(connections, (connection) =>
        prepare(connection).pipe(
          Effect.andThen(applyForHome(connection, isHome)),
          Effect.as(true),
          Effect.catch((error) =>
            Effect.logWarning("Slack connection did not follow the GOAT Bot home", {
              connectionId: connection.connectionId,
              error,
            }).pipe(Effect.as(false)),
          ),
        ),
      ),
      (results) => results.every(Boolean),
    );

  appliedHome = yield* lock.withPermits(1)(
    Effect.gen(function* () {
      const isHome = yield* readHome;
      // Bring saved connections back up. Unreadable secrets leave that connection in error.
      if (loaded.loadFailed) return isHome;
      const connections = yield* readConnections;
      const complete = yield* applyAllForHome(connections, isHome, (connection) =>
        deleteRevokedSecrets(connection).pipe(
          Effect.catch(() =>
            Effect.logWarning("Slack startup revocation cleanup failed; delivery stays blocked."),
          ),
        ),
      );
      return complete ? isHome : null;
    }),
  );

  yield* settingsChanges.pipe(
    Stream.runForEach(() =>
      lock
        .withPermits(1)(
          Effect.gen(function* () {
            // Queued snapshots can be stale; only the current home decides socket ownership.
            const isHome = yield* readHome;
            if (isHome === appliedHome) return;
            const connections = yield* readConnections;
            appliedHome = (yield* applyAllForHome(connections, isHome)) ? isHome : null;
          }),
        )
        .pipe(Effect.ignore({ log: true })),
    ),
    Effect.forkScoped,
  );

  return { ...service, configure };
});

export const layer = Layer.effect(SlackChannelSettings.SlackChannelSettings, make);
