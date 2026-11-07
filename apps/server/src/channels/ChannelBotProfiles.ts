import {
  BotId,
  BotProfile,
  CHANNEL_GATEWAY_WS_METHODS,
  ChannelBotRef,
  ChannelGatewayError,
  type ChannelUpdateBotInput,
  MAIN_BOT_ID,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { ChannelConnectionOwner } from "./ChannelIngressContext.ts";

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
const MemberRecord = Schema.Struct({ ...BotProfile.fields, role: Schema.Literal("member") });
const ProfileRecord = Schema.Union([MainRecord, MemberRecord]);
type ProfileRecord = typeof ProfileRecord.Type;
const decodeProfile = Schema.decodeUnknownSync(Schema.fromJsonString(ProfileRecord));
const encodeProfile = Schema.encodeSync(Schema.fromJsonString(ProfileRecord));
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
    ) => Effect.Effect<ReadonlyArray<BotProfile>, ChannelGatewayError>;
    readonly update: (
      input: ChannelUpdateBotInput,
      owner: ProfileOwner,
    ) => Effect.Effect<BotProfile, ChannelGatewayError>;
    /** The main bot's identity; an absent row was never edited, so it is the default. */
    readonly identity: (ownerId: string) => Effect.Effect<BotIdentity, ChannelGatewayError>;
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

const isGatewayError = Schema.is(ChannelGatewayError);
const persistenceFailed = Effect.mapError((cause: unknown) =>
  isGatewayError(cause) ? cause : new ChannelGatewayError({ reason: "persistence_failed" }),
);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  /** Every profile with its bot joined in, adopting the main bot once it exists. Runs inside a transaction. */
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
    const bots: ReadonlyArray<BotProfile> =
      decoded.bot === undefined || main === undefined
        ? members
        : [
            {
              ...main,
              environmentId: decoded.bot.environmentId,
              sessionThreadId: decoded.bot.threadId,
            },
            ...members,
          ];
    return { prefix, bots, records: main === undefined ? members : [main, ...members] };
  });

  const list = Effect.fn("ChannelBotProfiles.list")(function* (owner: ProfileOwner) {
    const now = DateTime.formatIso(yield* DateTime.now);
    return yield* sql.withTransaction(readProfiles(owner.ownerId, now)).pipe(
      Effect.map(({ bots }) => bots),
      Effect.tapError((cause) => Effect.logWarning("GOAT Bot profiles read failed", { cause })),
      persistenceFailed,
    );
  });

  const update = Effect.fn("ChannelBotProfiles.update")(function* (
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
          if (listed === undefined || record === undefined) {
            return yield* new ChannelGatewayError({ reason: "not_found" });
          }
          const changes = {
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.avatar === undefined ? {} : { avatar: input.avatar }),
            ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
            updatedAt: now,
          };
          const next: ProfileRecord = { ...record, ...changes };
          yield* sql`UPDATE channel_runtime_state
            SET value_json = ${encodeProfile(next)}, updated_at = ${now}
            WHERE key = ${prefix + encodeURIComponent(input.botId)}`;
          return { ...listed, ...changes };
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

  const identity = Effect.fn("ChannelBotProfiles.identity")(function* (ownerId: string) {
    const prefix = keyPrefix(ownerId);
    const mainKey = prefix + encodeURIComponent(MAIN_BOT_ID);
    return yield* sql<{ readonly value_json: string }>`
      SELECT value_json FROM channel_runtime_state WHERE key = ${mainKey}`.pipe(
      Effect.flatMap((rows) =>
        Effect.try(() => {
          if (rows[0] === undefined) return DEFAULT_BOT_IDENTITY;
          const profile = checkedProfile(prefix, mainKey, rows[0].value_json);
          return { name: profile.name, purpose: profile.purpose };
        }),
      ),
      Effect.tapError((cause) => Effect.logWarning("GOAT Bot identity read failed", { cause })),
      persistenceFailed,
    );
  });

  return ChannelBotProfiles.of({ list, update, identity });
});
export const layer = Layer.effect(ChannelBotProfiles, make);

export const rpcHandlers = (service: ChannelBotProfiles["Service"], owner: ProfileOwner) => ({
  [CHANNEL_GATEWAY_WS_METHODS.listBots]: () =>
    service.list(owner).pipe(Effect.map((bots) => ({ bots }))),
  [CHANNEL_GATEWAY_WS_METHODS.updateBot]: (input: ChannelUpdateBotInput) =>
    service.update(input, owner).pipe(Effect.map((bot) => ({ bot }))),
});
