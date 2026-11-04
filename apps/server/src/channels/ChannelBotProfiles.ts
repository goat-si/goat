import {
  BotId,
  BotProfile,
  ChannelBotRef,
  ChannelGatewayError,
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
const decodeProfile = Schema.decodeUnknownSync(Schema.fromJsonString(ProfileRecord));
const encodeMain = Schema.encodeSync(Schema.fromJsonString(MainRecord));
const decodeBot = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ bot: ChannelBotRef })),
);

export class ChannelBotProfiles extends Context.Service<
  ChannelBotProfiles,
  {
    readonly list: (
      owner: ChannelConnectionOwner,
    ) => Effect.Effect<ReadonlyArray<BotProfile>, ChannelGatewayError>;
  }
>()("goat/channels/ChannelBotProfiles") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const list = Effect.fn("ChannelBotProfiles.list")(function* (owner: ChannelConnectionOwner) {
    const prefix = "bot-profile:" + encodeURIComponent(owner.ownerId) + ":";
    const mainKey = prefix + encodeURIComponent(MAIN_BOT_ID);
    const botKey = "bot:" + owner.ownerId;
    const now = DateTime.formatIso(yield* DateTime.now);
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{ readonly key: string; readonly value_json: string }>`
        SELECT key, value_json FROM channel_runtime_state
        WHERE key = ${botKey} OR (key >= ${prefix} AND key < ${prefix.slice(0, -1) + ";"})
      `;
          const botRow = rows.find((row) => row.key === botKey);
          const decoded = yield* Effect.try(() => ({
            bot: botRow === undefined ? undefined : decodeBot(botRow.value_json).bot,
            profiles: rows
              .filter((row) => row.key !== botKey)
              .map((row) => {
                const profile = decodeProfile(row.value_json);
                if (
                  row.key !== prefix + encodeURIComponent(profile.botId) ||
                  (profile.role === "main") !== (profile.botId === MAIN_BOT_ID)
                ) {
                  throw new Error("Invalid bot profile key or role");
                }
                return profile;
              }),
          }));
          let main = decoded.profiles.find((profile) => profile.role === "main");
          if (decoded.bot !== undefined && main === undefined) {
            main = {
              botId: BotId.make(MAIN_BOT_ID),
              role: "main",
              name: "GOAT Bot",
              avatar: null,
              purpose: "",
              defaultModelSelection: null,
              defaultProjectId: null,
              createdAt: now,
              updatedAt: now,
            };
            yield* sql`INSERT INTO channel_runtime_state (key, value_json, updated_at)
          VALUES (${mainKey}, ${encodeMain(main)}, ${now}) ON CONFLICT (key) DO NOTHING`;
          }
          const members = decoded.profiles
            .filter((profile) => profile.role === "member")
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
          return decoded.bot === undefined || main === undefined
            ? members
            : [
                {
                  ...main,
                  environmentId: decoded.bot.environmentId,
                  sessionThreadId: decoded.bot.threadId,
                },
                ...members,
              ];
        }),
      )
      .pipe(Effect.mapError(() => new ChannelGatewayError({ reason: "persistence_failed" })));
  });
  return ChannelBotProfiles.of({ list });
});
export const layer = Layer.effect(ChannelBotProfiles, make);
