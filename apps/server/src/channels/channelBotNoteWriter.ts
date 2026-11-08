/**
 * The one writer of GOAT Bot's notes for this server. Reception's saves, the Memory tab's edits and
 * a session turn's saves share it, so they take one lock instead of one per caller.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import { ChannelTaskId } from "@goat/contracts";

import * as ServerConfig from "../config.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import { sqlRefusedNotes } from "./channelBotNoteRefusals.ts";
import { makeChannelBotNoteWriter } from "./channelBotNoteTabEdits.ts";
import { channelBotFilesFor } from "./channelBotNotes.ts";
import { makeWorkerLive } from "./channelWorkerLive.ts";

export class ChannelBotNoteWriter extends Context.Service<
  ChannelBotNoteWriter,
  Effect.Success<ReturnType<typeof makeChannelBotNoteWriter>>
>()("goat/channels/channelBotNoteWriter") {}

export const layer = Layer.effect(
  ChannelBotNoteWriter,
  Effect.gen(function* () {
    const files = channelBotFilesFor(yield* Path.Path, (yield* ServerConfig.ServerConfig).stateDir);
    const ledger = yield* ChannelLedger.ChannelLedger;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const workerLive = makeWorkerLive(threads, "ChannelBotNoteWriter.workerLive");
    // A stop that reached the worker is not yet a stopped worker: it waits for what a retry waits
    // for. A session turn shares its thread, so another request's work there also waits.
    const holderEnded = Effect.fn("ChannelBotNoteWriter.holderEnded")(function* (taskId: string) {
      const id = ChannelTaskId.make(taskId);
      if (yield* ledger.hasPendingForward(id)) return false;
      const stored = yield* ledger.getTask(id);
      return stored === undefined || !(yield* workerLive(stored.task));
    });
    return yield* makeChannelBotNoteWriter(
      yield* FileSystem.FileSystem,
      files,
      ledger,
      {},
      sqlRefusedNotes(yield* SqlClient.SqlClient),
      holderEnded,
    );
  }),
);
