import {
  AuthEnvironmentScopes,
  SlackBotBindings,
  RuntimeMode,
  SlackChannelConnectionId,
  SlackChannelDefaultTarget,
  SlackChannelScope,
  SlackUserAccess,
  TrimmedNonEmptyString,
  resolveSlackAccess,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";
import { unlinkedIdentity } from "../ChannelGateway.ts";

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
  // Absent in files saved before these existed; resolveSlackAccess supplies the defaults.
  channelScope: Schema.optional(SlackChannelScope),
  userAccess: Schema.optional(SlackUserAccess),
  unlinkedRuntimeModeCeiling: Schema.optional(RuntimeMode),
  defaultTarget: Schema.optional(SlackChannelDefaultTarget),
  botBindings: Schema.optionalKey(SlackBotBindings),
  owner: Schema.optional(StoredOwner),
});
export type StoredConnection = typeof StoredConnection.Type;

const SettingsFile = Schema.Struct({
  version: Schema.Literal(1),
  connections: Schema.Array(StoredConnection),
});
const SettingsFileJson = Schema.fromJsonString(SettingsFile);
export const decodeSettingsFile = Schema.decodeUnknownEffect(SettingsFileJson);
export const encodeSettingsFile = Schema.encodeEffect(SettingsFileJson);

export const SETTINGS_FILE_NAME = "slack-channel-settings.json";

export const workspaceIdentity = (connection: StoredConnection | undefined, actorId: string) => {
  if (connection?.owner === undefined) return undefined;
  const access = resolveSlackAccess(connection);
  return access.userAccess === "workspace"
    ? unlinkedIdentity(connection.owner, {
        connectionId: connection.connectionId,
        externalActorId: actorId,
        runtimeModeCeiling: access.unlinkedRuntimeModeCeiling,
      })
    : undefined;
};

export const makeReadSlackWorkspaceIdentity = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const settingsPath = path.join(config.stateDir, SETTINGS_FILE_NAME);
  return Effect.fn("slack.readWorkspaceIdentity")(function* (
    connectionId: string,
    actorId: string,
  ) {
    // The writer atomically replaces the file; provider startup can read it before Slack starts.
    const file = yield* fs.readFileString(settingsPath).pipe(Effect.flatMap(decodeSettingsFile));
    return workspaceIdentity(
      file.connections.find((stored) => stored.connectionId === connectionId),
      actorId,
    );
  });
});
