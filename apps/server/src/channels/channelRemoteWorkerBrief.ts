import type { ChannelRequester } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { readChannelBotNotesSnapshot, type ChannelBotFiles } from "./channelBotNotes.ts";
import { channelNotesRevision, freezeChannelBrief } from "./channelBriefs.ts";
import type * as ChannelLedger from "./ChannelLedger.ts";
import { readNamedSkills, remoteWorkerMessage } from "./channelWorkerBrief.ts";
import { canReadChannelBotNotes } from "./slack/slackNoteAccess.ts";

export const freezeRemoteWorkerBrief = Effect.fn("channel.freezeRemoteWorkerBrief")(function* <E>(
  ledger: ChannelLedger.ChannelLedger["Service"],
  stored: ChannelLedger.ChannelStoredTask,
  owner: string,
  files: ChannelBotFiles,
  dispatchRequester: Effect.Effect<ChannelRequester | undefined, E>,
  resume: string,
) {
  const requester = yield* dispatchRequester;
  if (requester === undefined) return undefined;
  const allowed = canReadChannelBotNotes(requester);
  const { task } = stored;
  const notes = allowed ? yield* readChannelBotNotesSnapshot(files, task.instruction) : undefined;
  const skills = yield* readNamedSkills(
    yield* FileSystem.FileSystem,
    yield* Path.Path,
    files,
    task.instruction,
  );
  const message = remoteWorkerMessage(task, { notes, skills }) + resume;
  const notesRevision =
    allowed && task.briefVersion === undefined && message.includes("<goat_bot_notes>")
      ? yield* channelNotesRevision(files.notes)
      : null;
  const frozen = yield* freezeChannelBrief(ledger, stored, owner, message, { notesRevision });
  const carriesNotes =
    frozen.brief.context.notesRevision != null ||
    (frozen.brief.deliveredText !== message &&
      frozen.brief.deliveredText.includes("\n<goat_bot_notes>\n"));
  if (!allowed && carriesNotes) return undefined;
  const notesAllowedNow =
    carriesNotes && requester.originKind === "slack"
      ? dispatchRequester.pipe(
          Effect.map((live) => live !== undefined && canReadChannelBotNotes(live)),
        )
      : Effect.succeed(true);
  return { ...frozen, notesAllowedNow };
});
