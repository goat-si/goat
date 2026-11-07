/**
 * ChannelBotDirectory - answers whether a thread is the canonical GOAT bot.
 *
 * Read-only and backed only by SQL, so the orchestrator can refuse coding turns on the bot
 * without depending on the gateway that writes to it.
 *
 * @module ChannelBotDirectory
 */
import { BotId, MAIN_BOT_ID, type ThreadId } from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const decodeMemberOwner = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ ownerId: Schema.String, botId: BotId })),
);

export class ChannelBotDirectoryError extends Schema.TaggedError<ChannelBotDirectoryError>()(
  "ChannelBotDirectoryError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not read the GOAT bot registry.";
  }
}

export class ChannelBotDirectory extends Context.Service<
  ChannelBotDirectory,
  {
    readonly isBotThread: (threadId: ThreadId) => Effect.Effect<boolean, ChannelBotDirectoryError>;
    /** The owner and bot whose current conversation is this thread, if any. */
    readonly botForThread: (
      threadId: ThreadId,
    ) => Effect.Effect<
      { readonly ownerId: string; readonly botId: BotId } | undefined,
      ChannelBotDirectoryError
    >;
  }
>()("goat/channels/ChannelBotDirectory") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const botsOnThread = (threadId: ThreadId) =>
    sql<{ readonly key: string; readonly value_json: string }>`
      SELECT key, value_json FROM channel_runtime_state
      WHERE key LIKE 'bot:%' AND json_extract(value_json, '$.bot.threadId') = ${threadId}
      LIMIT 1
    `.pipe(Effect.mapError((cause) => new ChannelBotDirectoryError({ cause })));
  return ChannelBotDirectory.of({
    isBotThread: (threadId) => botsOnThread(threadId).pipe(Effect.map((rows) => rows.length > 0)),
    botForThread: (threadId) =>
      botsOnThread(threadId).pipe(
        Effect.flatMap(([row]) =>
          row === undefined
            ? Effect.succeed(undefined)
            : row.key.startsWith("bot: ")
              ? Effect.try({
                  try: () => decodeMemberOwner(row.value_json),
                  catch: (cause) => new ChannelBotDirectoryError({ cause }),
                })
              : Effect.succeed({
                  ownerId: row.key.slice("bot:".length),
                  botId: BotId.make(MAIN_BOT_ID),
                }),
        ),
      ),
  });
});

export const layer = Layer.effect(ChannelBotDirectory, make);
