/**
 * The one writer of GOAT Bot's notes for this server. Reception's saves, the Memory tab's edits and
 * a session turn's saves share it, so they take one lock instead of one per caller.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
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
    const files = channelBotFilesFor(yield* Path.Path, (yield* ServerConfig.ServerConfig).stateDir);
    return yield* makeChannelBotNoteWriter(
      yield* FileSystem.FileSystem,
      files,
      yield* ChannelLedger.ChannelLedger,
    );
  }),
);
