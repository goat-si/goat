import { CommandId } from "@goat/contracts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ServerConfig from "../../config.ts";
import * as ChannelBotMembers from "../ChannelBotMembers.ts";
import * as ChannelGateway from "../ChannelGateway.ts";
import * as ChannelLedger from "../ChannelLedger.ts";
import * as ChannelReceptionService from "../ChannelReceptionService.ts";
import * as ChannelRuntime from "../ChannelRuntime.ts";
import { channelBotFilesFor } from "../channelBotNotes.ts";
import { taskIdFor } from "../channelIds.ts";
import {
  environmentId,
  goatInput,
  memoryRpcContext,
  modelSelection,
  owner,
  scratchProjectId,
  setupBot,
} from "./ChannelHarness.ts";

const createMember = Effect.gen(function* () {
  const members = yield* ChannelBotMembers.ChannelBotMembers;
  const member = yield* members.create(
    {
      clientRequestId: "notes-scout",
      name: "Scout",
      avatar: null,
      purpose: "",
      defaultModelSelection: null,
    },
    owner,
  );
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create-member-notes-thread"),
    threadId: member.sessionThreadId,
    projectId: scratchProjectId,
    title: "Scout",
    modelSelection,
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "system",
    creationSource: "server",
  });
});

export const setupMemberNotes = setupBot.pipe(Effect.andThen(createMember), Effect.asVoid);

export const notesMember = Effect.gen(function* () {
  const members = yield* ChannelBotMembers.ChannelBotMembers;
  const scout = (yield* members.list({}, owner)).find(
    (bot) => bot.role === "member" && bot.name === "Scout",
  );
  if (scout === undefined || scout.role !== "member")
    return yield* Effect.die("Scout is not configured");
  return scout;
});

export const memberNoteFiles = Effect.gen(function* () {
  return channelBotFilesFor(
    yield* Path.Path,
    (yield* ServerConfig.ServerConfig).stateDir,
    (yield* notesMember).botId,
  );
});

export const writeMemberNotes = Effect.fn("channelTest.writeMemberNotes")(function* (
  value: string,
) {
  const files = yield* memberNoteFiles;
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(files.dir, { recursive: true });
  yield* fs.writeFileString(files.notes, value);
  return files;
});

export const memberNoteInput = Effect.fn("channelTest.memberNoteInput")(function* (
  text: string,
  key: string,
) {
  const member = yield* notesMember;
  return {
    ...goatInput(text, key),
    conversationKey: member.sessionThreadId,
    replyAddress: { kind: "goat", environmentId, threadId: member.sessionThreadId } as const,
  };
});

export const askMemberNotes = Effect.fn("channelTest.askMemberNotes")(function* (
  text: string,
  key: string,
) {
  const gateway = yield* ChannelGateway.ChannelGateway;
  const runtime = yield* ChannelRuntime.ChannelRuntime;
  const reception = yield* ChannelReceptionService.ChannelReceptionService;
  const ledger = yield* ChannelLedger.ChannelLedger;
  yield* runtime.drain;
  const input = yield* gateway.ingest(
    yield* memberNoteInput("look: " + text, key),
    memoryRpcContext,
  );
  yield* reception.receive(input.inputId, runtime.ownerToken);
  yield* runtime.drain;
  const task = yield* ledger.getTask(taskIdFor(input.inputId, 0));
  if (task === undefined) return yield* Effect.die("The note task did not start");
  return task.task;
});
