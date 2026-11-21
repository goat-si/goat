import * as Effect from "effect/Effect";
import { prependStandingInstructions } from "@goat/shared/standingInstructions";
import type { BotIdentity } from "./ChannelBotProfiles.ts";
import type { ChannelLedger, ChannelStoredTask } from "./ChannelLedger.ts";
import { recallChannelBotNotes, type ChannelBotFiles } from "./channelBotNotes.ts";
import { channelBotNotesSection } from "./channelBotNotesRecall.ts";
import { identitySection } from "./channelBotSessionBrief.ts";
import { freezeChannelBrief, localNotesBriefContext } from "./channelBriefs.ts";
import { workerInstruction } from "./channelWorkerBrief.ts";

export const freezeLocalWorkerBrief = Effect.fn("channel.freezeLocalWorkerBrief")(function* (
  ledger: ChannelLedger["Service"],
  stored: ChannelStoredTask,
  owner: string,
  files: ChannelBotFiles,
  identity: BotIdentity,
  standingInstructions: string,
  mayRead: boolean,
  mayWrite: boolean,
) {
  const { task } = stored;
  const notes = yield* recallChannelBotNotes(files, task.instruction, mayRead);
  const prompt =
    identitySection(identity) +
    workerInstruction(task, files, {
      read: mayRead,
      write: mayWrite,
      notes: notes === undefined ? "" : channelBotNotesSection(notes),
    });
  const context = yield* localNotesBriefContext(files, mayRead, task.briefVersion);
  return yield* freezeChannelBrief(
    ledger,
    stored,
    owner,
    prependStandingInstructions(standingInstructions, prompt).text,
    context,
  );
});
