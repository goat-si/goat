import {
  BotId,
  BotProfile,
  ChannelBotRef,
  ChannelGatewayError,
  type ChannelUpdateBotInput,
  MAIN_BOT_ID,
  type ModelSelection,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { ChannelConnectionOwner } from "./ChannelIngressContext.ts";
import { botProfileKey, memberBotKey } from "./channelBotLedger.ts";

const MainRecord = Schema.Struct({
  botId: BotProfile.fields.botId,
  role: Schema.Literal("main"),
  name: BotProfile.fields.name,
  avatar: BotProfile.fields.avatar,
  purpose: BotProfile.fields.purpose,
  defaultModelSelection: BotProfile.fields.defaultModelSelection,
  defaultProjectId: BotProfile.fields.defaultProjectId,
  createdAt: BotProfile.fields.createdAt,
  updatedAt: BotProfile.fields.updatedAt,
});
/** A thread step a delete or restore committed and has not finished yet. */
const Lifecycle = Schema.Struct({
  pending: Schema.Literals(["archive", "unarchive"]),
  at: Schema.String,
});
// Keeps every field older builds require of a member row, so they can still list profiles.
const MemberRecord = Schema.Struct({
  ...BotProfile.fields,
  role: Schema.Literal("member"),
  lifecycle: Schema.optionalKey(Lifecycle),
});
export type MemberRecord = typeof MemberRecord.Type;
const ProfileRecord = Schema.Union([MainRecord, MemberRecord]);
type ProfileRecord = typeof ProfileRecord.Type;
const decodeProfile = Schema.decodeUnknownSync(Schema.fromJsonString(ProfileRecord));
export const encodeProfile = Schema.encodeSync(Schema.fromJsonString(ProfileRecord));
const decodeBot = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ bot: ChannelBotRef })),
);

/** What a bot is told about itself: the name people gave it and the job they wrote for it. */
export interface BotIdentity {
  readonly name: string;
  readonly purpose: string;
}
export const DEFAULT_BOT_IDENTITY: BotIdentity = { name: "GOAT Bot", purpose: "" };

type ProfileOwner = Pick<ChannelConnectionOwner, "ownerId">;

export class ChannelBotProfiles extends Context.Service<
  ChannelBotProfiles,
  {
    readonly list: (
      owner: ProfileOwner,
      options?: { readonly includeDeleted?: boolean | undefined },
    ) => Effect.Effect<ReadonlyArray<BotProfile>, ChannelGatewayError>;
    readonly update: (
      input: ChannelUpdateBotInput,
      owner: ProfileOwner,
    ) => Effect.Effect<BotProfile, ChannelGatewayError>;
    /** The same write, with the fields whose stored value it changed. */
    readonly updateWithChanges: (
      input: ChannelUpdateBotInput,
      owner: ProfileOwner,
    ) => Effect.Effect<
      { readonly bot: BotProfile; readonly changed: ReadonlyArray<"name" | "purpose"> },
      ChannelGatewayError
    >;
    /** A bot's identity; an absent main row was never edited, so it is the default. */
    readonly identity: (
      ownerId: string,
      botId: BotId,
    ) => Effect.Effect<BotIdentity, ChannelGatewayError>;
    /** The model a member was given; null for main, which follows the GOAT Bot setting. */
    readonly modelFor: (
      ownerId: string,
      botId: BotId,
    ) => Effect.Effect<ModelSelection | null, ChannelGatewayError>;
  }
>()("goat/channels/ChannelBotProfiles") {}

const keyPrefix = (ownerId: string) => "bot-profile:" + encodeURIComponent(ownerId) + ":";

/** A stored profile, refused when its key or role does not match what it says it is. */
const checkedProfile = (prefix: string, key: string, json: string) => {
  const profile = decodeProfile(json);
  if (
    key !== prefix + encodeURIComponent(profile.botId) ||
    (profile.role === "main") !== (profile.botId === MAIN_BOT_ID)
  ) {
    throw new Error("Invalid bot profile key or role");
  }
  return profile;
};

/** A member as a client sees it: no lifecycle bookkeeping. */
export const memberProfile = ({ lifecycle: _lifecycle, ...profile }: MemberRecord): BotProfile =>
  profile;

/** The stored profile row, or undefined; runs in the caller's transaction when there is one. */
export const readProfileRecord = (sql: SqlClient.SqlClient, ownerId: string, botId: string) =>
  sql<{ readonly value_json: string }>`
    SELECT value_json FROM channel_runtime_state WHERE key = ${botProfileKey(ownerId, botId)}`.pipe(
    Effect.flatMap((rows) =>
      Effect.try(() =>
        rows[0] === undefined
          ? undefined
          : checkedProfile(keyPrefix(ownerId), botProfileKey(ownerId, botId), rows[0].value_json),
      ),
    ),
  );

const isGatewayError = Schema.is(ChannelGatewayError);

/** A color edit: a value sets it, null removes it, and leaving it out keeps the stored one. */
const withColor = <T extends { readonly color?: string }>(
  profile: T,
  color: string | null | undefined,
): T => {
  if (color === undefined) return profile;
  if (color !== null) return { ...profile, color };
  const { color: _cleared, ...rest } = profile;
  return rest as T;
};
const persistenceFailed = Effect.mapError((cause: unknown) =>
  isGatewayError(cause) ? cause : new ChannelGatewayError({ reason: "persistence_failed" }),
);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  /** Every profile with its bot ref joined in, adopting the main bot once it exists. In a transaction. */
  const readProfiles = Effect.fn("ChannelBotProfiles.readProfiles")(function* (
    ownerId: string,
    now: string,
  ) {
    const prefix = keyPrefix(ownerId);
    const mainKey = prefix + encodeURIComponent(MAIN_BOT_ID);
    const botKey = "bot:" + ownerId;
    const rows = yield* sql<{ readonly key: string; readonly value_json: string }>`
        SELECT key, value_json FROM channel_runtime_state
        WHERE key = ${botKey} OR (key >= ${prefix} AND key < ${prefix.slice(0, -1) + ";"})
      `;
    const botRow = rows.find((row) => row.key === botKey);
    const decoded = yield* Effect.try(() => ({
      bot: botRow === undefined ? undefined : decodeBot(botRow.value_json).bot,
      profiles: rows
        .filter((row) => row.key !== botKey)
        .map((row) => checkedProfile(prefix, row.key, row.value_json)),
    }));
    let main = decoded.profiles.find((profile) => profile.role === "main");
    if (decoded.bot !== undefined && main === undefined) {
      main = {
        botId: BotId.make(MAIN_BOT_ID),
        role: "main",
        name: DEFAULT_BOT_IDENTITY.name,
        avatar: null,
        purpose: DEFAULT_BOT_IDENTITY.purpose,
        defaultModelSelection: null,
        defaultProjectId: null,
        createdAt: now,
        updatedAt: now,
      };
      yield* sql`INSERT INTO channel_runtime_state (key, value_json, updated_at)
          VALUES (${mainKey}, ${encodeProfile(main)}, ${now}) ON CONFLICT (key) DO NOTHING`;
      // A concurrent list may have adopted first; report the stored row, not this attempt.
      const stored = yield* sql<{ readonly value_json: string }>`
          SELECT value_json FROM channel_runtime_state WHERE key = ${mainKey}`;
      const adopted = stored[0] === undefined ? undefined : decodeProfile(stored[0].value_json);
      if (adopted?.role === "main") main = adopted;
    }
    const members = decoded.profiles
      .filter((profile) => profile.role === "member")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    // A member is listed once its ref exists; until then its create is still finishing.
    const refPrefix = memberBotKey(ownerId, "");
    const refRows =
      members.length === 0
        ? []
        : yield* sql<{ readonly key: string }>`
            SELECT key FROM channel_runtime_state
            WHERE key >= ${refPrefix} AND key < ${refPrefix.slice(0, -1) + ";"}`;
    const launched = new Set(refRows.map((row) => row.key));
    const listedMembers = members
      .filter((member) => launched.has(memberBotKey(ownerId, member.botId)))
      .map(memberProfile);
    const bots: ReadonlyArray<BotProfile> =
      decoded.bot === undefined || main === undefined
        ? listedMembers
        : [
            {
              ...main,
              environmentId: decoded.bot.environmentId,
              sessionThreadId: decoded.bot.threadId,
            },
            ...listedMembers,
          ];
    return { prefix, bots, records: main === undefined ? members : [main, ...members] };
  });

  const list = Effect.fn("ChannelBotProfiles.list")(function* (
    owner: ProfileOwner,
    options: { readonly includeDeleted?: boolean | undefined } = {},
  ) {
    const now = DateTime.formatIso(yield* DateTime.now);
    return yield* sql.withTransaction(readProfiles(owner.ownerId, now)).pipe(
      Effect.map(({ bots }) =>
        options.includeDeleted === true ? bots : bots.filter((bot) => bot.state !== "deleted"),
      ),
      Effect.tapError((cause) => Effect.logWarning("GOAT Bot profiles read failed", { cause })),
      persistenceFailed,
    );
  });

  const updateWithChanges = Effect.fn("ChannelBotProfiles.update")(function* (
    input: ChannelUpdateBotInput,
    owner: ProfileOwner,
  ) {
    const now = DateTime.formatIso(yield* DateTime.now);
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const { prefix, bots, records } = yield* readProfiles(owner.ownerId, now);
          const listed = bots.find((bot) => bot.botId === input.botId);
          const record = records.find((profile) => profile.botId === input.botId);
          if (listed === undefined || record === undefined || listed.state === "deleted") {
            return yield* new ChannelGatewayError({ reason: "not_found" });
          }
          // The main bot's model is the GOAT Bot model setting, which modelFor reads instead.
          // Its look stays the theme's: a color sent for it is refused.
          if (
            record.role === "main" &&
            (input.defaultModelSelection !== undefined || (input.color ?? null) !== null)
          ) {
            return yield* new ChannelGatewayError({ reason: "invalid_input" });
          }
          const changes = {
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.avatar === undefined ? {} : { avatar: input.avatar }),
            ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
            ...(input.defaultModelSelection === undefined
              ? {}
              : { defaultModelSelection: input.defaultModelSelection }),
            updatedAt: now,
          };
          const next: ProfileRecord =
            record.role === "member"
              ? withColor({ ...record, ...changes }, input.color)
              : { ...record, ...changes };
          yield* sql`UPDATE channel_runtime_state
            SET value_json = ${encodeProfile(next)}, updated_at = ${now}
            WHERE key = ${prefix + encodeURIComponent(input.botId)}`;
          const changed = (["name", "purpose"] as const).filter(
            (field) => input[field] !== undefined && input[field] !== record[field],
          );
          return { bot: withColor({ ...listed, ...changes }, input.color), changed };
        }),
      )
      .pipe(
        Effect.tapError((cause) =>
          isGatewayError(cause)
            ? Effect.void
            : Effect.logWarning("GOAT Bot profile update failed", { cause }),
        ),
        persistenceFailed,
      );
  });
  const update: ChannelBotProfiles["Service"]["update"] = (input, owner) =>
    updateWithChanges(input, owner).pipe(Effect.map(({ bot }) => bot));

  const identity = Effect.fn("ChannelBotProfiles.identity")(function* (
    ownerId: string,
    botId: BotId,
  ) {
    return yield* readProfileRecord(sql, ownerId, botId).pipe(
      Effect.flatMap((profile) =>
        profile !== undefined
          ? Effect.succeed({ name: profile.name, purpose: profile.purpose })
          : botId === MAIN_BOT_ID
            ? Effect.succeed(DEFAULT_BOT_IDENTITY)
            : Effect.fail(new ChannelGatewayError({ reason: "not_found" })),
      ),
      Effect.tapError((cause) => Effect.logWarning("GOAT Bot identity read failed", { cause })),
      persistenceFailed,
    );
  });

  const modelFor = Effect.fn("ChannelBotProfiles.modelFor")(function* (
    ownerId: string,
    botId: BotId,
  ) {
    if (botId === MAIN_BOT_ID) return null;
    return yield* readProfileRecord(sql, ownerId, botId).pipe(
      Effect.map((profile) => profile?.defaultModelSelection ?? null),
      Effect.tapError((cause) => Effect.logWarning("GOAT Bot model read failed", { cause })),
      persistenceFailed,
    );
  });

  return ChannelBotProfiles.of({ list, update, updateWithChanges, identity, modelFor });
});
export const layer = Layer.effect(ChannelBotProfiles, make);
