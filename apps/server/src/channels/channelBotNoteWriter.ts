/**
 * The one writer of GOAT Bot's notes for this server. Reception's saves, the Memory tab's edits and
 * a session turn's saves share it, so they take one lock instead of one per caller.
 */
import { BotId, ChannelInputId, MAIN_BOT_ID } from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ChannelBotEvents from "./ChannelBotEvents.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import { makeChannelBotNoteWriter } from "./channelBotNoteTabEdits.ts";
import { channelBotFilesFor } from "./channelBotNotes.ts";

export class ChannelBotNoteWriter extends Context.Service<
  ChannelBotNoteWriter,
  Effect.Success<ReturnType<typeof makeChannelBotNoteWriter>>
>()("goat/channels/channelBotNoteWriter") {}

export const layer = Layer.effect(
  ChannelBotNoteWriter,
  Effect.gen(function* () {
    const ledger = yield* ChannelLedger.ChannelLedger;
    const events = yield* ChannelBotEvents.ChannelBotEvents;
    const files = channelBotFilesFor(yield* Path.Path, (yield* ServerConfig.ServerConfig).stateDir);
    return yield* makeChannelBotNoteWriter(yield* FileSystem.FileSystem, files, ledger, {
      onWrote: Effect.fn("channelBotNoteWriter.onWrote")(
        function* (inputId: string) {
          const input = yield* ledger.getInput(ChannelInputId.make(inputId));
          if (input === undefined || input.message.kind === "goat") return;
          yield* events.emit({
            ownerId: input.ownerId,
            botId: BotId.make(MAIN_BOT_ID),
            kind: "memory-updated",
            id: inputId,
            text: "Memory updated",
          });
        },
        Effect.catchCause((cause) =>
          Effect.logWarning("GOAT Bot memory update line was not queued", { cause }),
        ),
      ),
    });
  }),
);
