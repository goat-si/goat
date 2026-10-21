/**
 * ChannelBotDirectory - answers whether a thread is the canonical GOAT bot.
 *
 * Read-only and backed only by SQL, so the orchestrator can refuse coding turns on the bot
 * without depending on the gateway that writes to it.
 *
 * @module ChannelBotDirectory
 */
import type { ThreadId } from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

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
  }
>()("goat/channels/ChannelBotDirectory") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return ChannelBotDirectory.of({
    isBotThread: (threadId) =>
      sql<{ readonly key: string }>`
        SELECT key FROM channel_runtime_state
        WHERE key LIKE 'bot:%' AND json_extract(value_json, '$.bot.threadId') = ${threadId}
        LIMIT 1
      `.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.mapError((cause) => new ChannelBotDirectoryError({ cause })),
      ),
  });
});

export const layer = Layer.effect(ChannelBotDirectory, make);
