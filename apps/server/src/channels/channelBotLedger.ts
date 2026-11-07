/**
 * Bot refs: main at "bot:<owner>", a member at "bot: <owner>:<botId>" (encoded). Owner ids are
 * trimmed, so no main key has a space after "bot:"; both still match the "bot:%" scan
 * ChannelBotDirectory and older builds use to recognise bot threads.
 */
import { BotId, ChannelBotRef, MAIN_BOT_ID, type ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

import { ChannelLedgerError } from "./channelLedgerError.ts";

const MainState = Schema.Struct({
  bot: ChannelBotRef,
  legacyThreadId: Schema.optional(Schema.String),
  // Present only on member rows; a main read that finds it refuses the row.
  botId: Schema.optional(Schema.String),
});
const MemberState = Schema.Struct({ bot: ChannelBotRef, ownerId: Schema.String, botId: BotId });
const encodeMain = Schema.encodeSync(Schema.fromJsonString(MainState));
const decodeMain = Schema.decodeUnknownSync(Schema.fromJsonString(MainState));
const decodeMember = Schema.decodeUnknownSync(Schema.fromJsonString(MemberState));
const encodeMember = Schema.encodeSync(Schema.fromJsonString(MemberState));

export const mainBotKey = (ownerId: string) => "bot:" + ownerId;
export const botProfileKey = (ownerId: string, botId: string) =>
  "bot-profile:" + encodeURIComponent(ownerId) + ":" + encodeURIComponent(botId);
export const memberBotKey = (ownerId: string, botId: string) =>
  "bot: " + encodeURIComponent(ownerId) + ":" + encodeURIComponent(botId);

type MainBot = { readonly bot: ChannelBotRef; readonly legacyThreadId: ThreadId | undefined };

export interface ChannelBotLedgerOps {
  readonly getBot: (ownerId: string) => Effect.Effect<MainBot | undefined, ChannelLedgerError>;
  /** The bot a stored input or task belongs to, in any state; main for the main bot. */
  readonly getBotById: (
    ownerId: string,
    botId: BotId,
  ) => Effect.Effect<{ readonly bot: ChannelBotRef } | undefined, ChannelLedgerError>;
  /** Records the canonical bot unless one exists; returns whichever is stored. */
  readonly setBotIfAbsent: (input: {
    readonly ownerId: string;
    readonly bot: ChannelBotRef;
    readonly legacyThreadId?: ThreadId | undefined;
    readonly now: string;
  }) => Effect.Effect<ChannelBotRef, ChannelLedgerError>;
  /**
   * Replaces the canonical bot if it is still `previousThreadId`, keeping any legacy thread;
   * returns whichever bot is stored afterwards.
   */
  readonly replaceBot: (input: {
    readonly ownerId: string;
    readonly previousThreadId: ThreadId;
    readonly bot: ChannelBotRef;
    readonly now: string;
  }) => Effect.Effect<ChannelBotRef, ChannelLedgerError>;
  /**
   * The active bot a new message on this thread is for, scoped to the owner: main, or a member
   * that is active. Undefined for any other thread.
   */
  readonly resolveIngressBot: (
    ownerId: string,
    threadId: ThreadId,
  ) => Effect.Effect<
    { readonly botId: BotId; readonly bot: ChannelBotRef } | undefined,
    ChannelLedgerError
  >;
  /** Records a member's ref unless one exists; returns whichever is stored. */
  readonly setMemberBotIfAbsent: (input: {
    readonly ownerId: string;
    readonly botId: BotId;
    readonly bot: ChannelBotRef;
    readonly now: string;
  }) => Effect.Effect<ChannelBotRef, ChannelLedgerError>;
  /**
   * Gives tasks back the bot of the input that created them. An older build creates tasks with
   * the column default, main, even for a member's input; the input row keeps its bot. Returns
   * how many tasks changed; a second run changes none.
   */
  readonly repairTaskBots: () => Effect.Effect<number, ChannelLedgerError>;
}

const isLedgerError = Schema.is(ChannelLedgerError);
const toLedgerError = (detail: string) => (cause: unknown) =>
  isLedgerError(cause) ? cause : new ChannelLedgerError({ reason: "persistence", detail, cause });

const checkedOwner = (ownerId: string) =>
  ownerId.length > 0 && ownerId.trim() === ownerId
    ? Effect.succeed(ownerId)
    : Effect.fail(
        new ChannelLedgerError({ reason: "persistence", detail: "Invalid channel owner id." }),
      );

/** Whether a member's profile is active; run inside the transaction that stores its input. */
export const isActiveMember = (sql: SqlClient.SqlClient, ownerId: string, botId: string) =>
  sql<{ readonly found: number }>`
    SELECT 1 AS found FROM channel_runtime_state WHERE key = ${botProfileKey(ownerId, botId)}
      AND json_extract(value_json, '$.role') = 'member'
      AND COALESCE(json_extract(value_json, '$.state'), 'active') = 'active'
  `.pipe(Effect.map((rows) => rows.length > 0));

export const botLedger = (sql: SqlClient.SqlClient): ChannelBotLedgerOps => {
  const readMain = (ownerId: string) =>
    sql<{ readonly value_json: string }>`
      SELECT value_json FROM channel_runtime_state WHERE key = ${mainBotKey(ownerId)}
    `.pipe(
      Effect.flatMap((rows) =>
        Effect.try(() => {
          if (rows[0] === undefined) return undefined;
          const stored = decodeMain(rows[0].value_json);
          if (stored.botId !== undefined) throw new Error("A member row under a main bot key");
          return stored;
        }),
      ),
    );

  const getBot: ChannelBotLedgerOps["getBot"] = (ownerId) =>
    checkedOwner(ownerId).pipe(
      Effect.flatMap(readMain),
      Effect.map((stored) =>
        stored === undefined
          ? undefined
          : { bot: stored.bot, legacyThreadId: stored.legacyThreadId as ThreadId | undefined },
      ),
      Effect.mapError(toLedgerError("getBot")),
    );

  const getBotById: ChannelBotLedgerOps["getBotById"] = (ownerId, botId) =>
    botId === MAIN_BOT_ID
      ? getBot(ownerId)
      : readMember(ownerId, botId).pipe(
          Effect.map((bot) => (bot === undefined ? undefined : { bot })),
          Effect.mapError(toLedgerError("getBotById")),
        );

  const setBotIfAbsent: ChannelBotLedgerOps["setBotIfAbsent"] = (input) =>
    checkedOwner(input.ownerId).pipe(
      Effect.andThen(
        sql.withTransaction(
          Effect.gen(function* () {
            const value = encodeMain({
              bot: input.bot,
              ...(input.legacyThreadId === undefined
                ? {}
                : { legacyThreadId: input.legacyThreadId }),
            });
            yield* sql`
              INSERT INTO channel_runtime_state (key, value_json, updated_at)
              VALUES (${mainBotKey(input.ownerId)}, ${value}, ${input.now})
              ON CONFLICT (key) DO NOTHING
            `;
            const stored = yield* readMain(input.ownerId);
            return stored === undefined ? input.bot : stored.bot;
          }),
        ),
      ),
      Effect.mapError(toLedgerError("setBotIfAbsent")),
    );

  const replaceBot: ChannelBotLedgerOps["replaceBot"] = (input) =>
    checkedOwner(input.ownerId).pipe(
      Effect.andThen(
        sql.withTransaction(
          Effect.gen(function* () {
            const current = yield* readMain(input.ownerId);
            if (current === undefined || current.bot.threadId !== input.previousThreadId) {
              return current?.bot ?? input.bot;
            }
            yield* sql`
              UPDATE channel_runtime_state SET value_json = ${encodeMain({
                bot: input.bot,
                ...(current.legacyThreadId === undefined
                  ? {}
                  : { legacyThreadId: current.legacyThreadId }),
              })}, updated_at = ${input.now}
              WHERE key = ${mainBotKey(input.ownerId)}
            `;
            return input.bot;
          }),
        ),
      ),
      Effect.mapError(toLedgerError("replaceBot")),
    );

  const readMember = (ownerId: string, botId: string) =>
    sql<{ readonly value_json: string }>`
      SELECT value_json FROM channel_runtime_state WHERE key = ${memberBotKey(ownerId, botId)}
    `.pipe(
      Effect.flatMap((rows) =>
        Effect.try(() => {
          if (rows[0] === undefined) return undefined;
          const stored = decodeMember(rows[0].value_json);
          return stored.ownerId === ownerId && stored.botId === botId ? stored.bot : undefined;
        }),
      ),
    );

  const resolveIngressBot: ChannelBotLedgerOps["resolveIngressBot"] = Effect.fn(
    "ChannelLedger.resolveIngressBot",
  )(
    function* (ownerId, threadId) {
      const main = yield* readMain(yield* checkedOwner(ownerId));
      if (main?.bot.threadId === threadId) return { botId: BotId.make(MAIN_BOT_ID), bot: main.bot };
      // Member keys are "bot: ...": the range from "bot: " to "bot:!" holds exactly those.
      const rows = yield* sql<{ readonly key: string; readonly value_json: string }>`
        SELECT key, value_json FROM channel_runtime_state
        WHERE key >= 'bot: ' AND key < 'bot:!'
          AND json_extract(value_json, '$.bot.threadId') = ${threadId}
      `;
      for (const row of rows) {
        const stored = yield* Effect.try(() => decodeMember(row.value_json));
        if (stored.ownerId !== ownerId || row.key !== memberBotKey(ownerId, stored.botId)) continue;
        if (!(yield* isActiveMember(sql, ownerId, stored.botId))) return undefined;
        return { botId: stored.botId, bot: stored.bot };
      }
      return undefined;
    },
    Effect.mapError(toLedgerError("resolveIngressBot")),
  );

  const setMemberBotIfAbsent: ChannelBotLedgerOps["setMemberBotIfAbsent"] = (input) =>
    checkedOwner(input.ownerId).pipe(
      Effect.andThen(
        sql.withTransaction(
          Effect.gen(function* () {
            const value = encodeMember({
              bot: input.bot,
              ownerId: input.ownerId,
              botId: input.botId,
            });
            yield* sql`
              INSERT INTO channel_runtime_state (key, value_json, updated_at)
              VALUES (${memberBotKey(input.ownerId, input.botId)}, ${value}, ${input.now})
              ON CONFLICT (key) DO NOTHING
            `;
            const stored = yield* readMember(input.ownerId, input.botId);
            if (stored === undefined) {
              return yield* new ChannelLedgerError({
                reason: "persistence",
                detail: "Another record holds this member bot's key.",
              });
            }
            return stored;
          }),
        ),
      ),
      Effect.mapError(toLedgerError("setMemberBotIfAbsent")),
    );

  // Walks only member inputs (a partial index) and the tasks each one created.
  const repairTaskBots: ChannelBotLedgerOps["repairTaskBots"] = () =>
    sql<{ readonly task_id: string }>`
      UPDATE channel_tasks SET bot_id = created.bot_id
      FROM (
        SELECT i.input_id, i.owner_id, i.bot_id, j.value AS task_id
        FROM channel_inbox i, json_each(i.task_ids_json) j
        WHERE i.bot_id <> 'main'
      ) AS created
      WHERE channel_tasks.task_id = created.task_id
        AND channel_tasks.owner_id = created.owner_id
        AND channel_tasks.bot_id = 'main'
        AND json_extract(channel_tasks.task_json, '$.originInputId') = created.input_id
      RETURNING channel_tasks.task_id
    `.pipe(
      Effect.map((rows) => rows.length),
      Effect.mapError(toLedgerError("repairTaskBots")),
    );

  return {
    getBot,
    getBotById,
    setBotIfAbsent,
    replaceBot,
    resolveIngressBot,
    setMemberBotIfAbsent,
    repairTaskBots,
  };
};
