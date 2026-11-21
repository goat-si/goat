import { canReadChannelBotNotes } from "./slack/slackNoteAccess.ts";
import type { ChannelRequester } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { ChannelBotProfiles } from "./ChannelBotProfiles.ts";
import type { ChannelLedger, ChannelStoredTask } from "./ChannelLedger.ts";
import { channelBotFilesFor, recallChannelBotNotes } from "./channelBotNotes.ts";
import { identitySection } from "./channelBotSessionBrief.ts";
import { channelNotesRevision, freezeChannelBrief } from "./channelBriefs.ts";
import { readNamedSkills, remoteWorkerMessage } from "./channelWorkerBrief.ts";

export const makeRemoteBotBrief = (deps: {
  readonly ledger: ChannelLedger["Service"];
  readonly profiles: ChannelBotProfiles["Service"];
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly stateDir: string;
}) =>
  Effect.fn("channel.remoteBotBrief")(
    function* (
      stored: ChannelStoredTask,
      owner: string,
      requester: ChannelRequester,
      suffix: string,
    ) {
      const { task } = stored;
      const files = channelBotFilesFor(deps.path, deps.stateDir, stored.botId);
      const mayRead = task.routineWork !== true && canReadChannelBotNotes(requester);
      const identity = yield* deps.profiles.identity(stored.ownerId, stored.botId);
      const notes = yield* recallChannelBotNotes(files, task.instruction, mayRead);
      const skills = yield* readNamedSkills(deps.fileSystem, deps.path, files, task.instruction);
      const message = remoteWorkerMessage(task, {
        notes,
        skills,
        prefix: identitySection(identity),
        suffix,
      });
      const notesRevision =
        task.briefVersion === undefined && notes?.standing
          ? yield* channelNotesRevision(files.notes)
          : null;
      const frozen = yield* freezeChannelBrief(deps.ledger, stored, owner, message, {
        notesRevision,
      });
      const sendsNotes = frozen.brief.deliveredText.includes("<goat_bot_notes>");
      return { ...frozen, sendsNotes, denied: sendsNotes && !mayRead };
    },
    Effect.provideService(FileSystem.FileSystem, deps.fileSystem),
  );
