/**
 * A finished task's skill proposal becomes a server-owned task that asks Save / Not now and never
 * runs a worker. Only a recorded Save writes goat-bot/skills/<name>.md, create-only, under one
 * write lock with the completion, so a resumed or ownerless attempt writes nothing.
 * @module channelSkillProposals
 */
import {
  type ChannelSkillProposal,
  type ChannelTaskEvent,
  ChannelTaskId,
  type RunId,
  SKILL_PROPOSAL_OPTIONS,
  SKILL_PROPOSAL_SAVE,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";

import * as ServerConfig from "../config.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import { channelBotFilesFor } from "./channelBotNotes.ts";
import { questionIdFor, skillProposalTaskIdFor, taskEventIdFor } from "./channelIds.ts";
import { makeRoutineInputs } from "./channelRoutineInputs.ts";
import {
  skillFileText,
  skillProposalDropReason,
  skillProposalQuestion,
} from "./channelSkillProposalText.ts";
import { type ChannelTaskEventSpec, commitTransition, makeTaskEvent } from "./channelTaskWrites.ts";

/** Leftover temporary files one save clears; each is at most one proposal. */
const SWEEP_LIMIT = 50;
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const tmpPattern = /^\.[a-z0-9-]+\.md\.(channel-task-[A-Za-z0-9_-]+)\.[a-z0-9-]+\.tmp$/u;

type Answer = Extract<ChannelTaskEvent, { readonly type: "task.question.answered" }>;

const sameBytes = (left: Uint8Array, right: Uint8Array) =>
  left.length === right.length && left.every((byte, index) => byte === right[index]);

const skillFiles = Effect.gen(function* () {
  const path = yield* Path.Path;
  const files = channelBotFilesFor(path, (yield* ServerConfig.ServerConfig).stateDir);
  return { path, files, skillPath: (name: string) => path.join(files.skills, name + ".md") };
});

/** Offers a completed task's proposal; used where runs settle. */
export const makeSkillProposalOffers = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const { skillPath } = yield* skillFiles;
  const routines = yield* makeRoutineInputs;

  /**
   * The proposal task a successful completion starts, as createdTasks for its transition, or
   * nothing when the run made no proposal or it is dropped.
   */
  const offerFor = Effect.fn("ChannelSkillProposals.offerFor")(function* (
    stored: ChannelLedger.ChannelStoredTask,
    runId: RunId,
    settled: ChannelTaskEventSpec,
  ) {
    const source = stored.task;
    const proposal: ChannelSkillProposal | undefined =
      source.proposedCompletion?.runId === runId
        ? source.proposedCompletion.skillProposal
        : undefined;
    if (proposal === undefined || settled.type !== "task.completed") return {};
    const reason =
      skillProposalDropReason(source, proposal) ??
      ((yield* routines.isRoutineInput(source.originInputId)) ? "unattended" : undefined) ??
      ((yield* fs.exists(skillPath(proposal.name)).pipe(Effect.orElseSucceed(() => true)))
        ? "name_taken"
        : undefined);
    if (reason !== undefined) {
      yield* Effect.logInfo("GOAT Bot skill proposal dropped", { taskId: source.taskId, reason });
      return {};
    }
    const now = DateTime.formatIso(yield* DateTime.now);
    const taskId = skillProposalTaskIdFor(source.taskId, source.generation);
    const title = "Save skill " + proposal.name + "?";
    // An older server that dispatches this task after a downgrade runs a harmless no-op.
    const instruction =
      "Nothing to do: this records a skill proposal for a newer GOAT. Report completed.";
    const task = {
      taskId,
      conversationId: source.conversationId,
      originBindingId: source.originBindingId,
      originAddress: source.originAddress,
      originInputId: source.originInputId,
      requester: source.requester,
      title,
      instruction,
      status: "received" as const,
      version: 1,
      generation: 1,
      skillProposal: {
        ...proposal,
        sourceTaskId: source.taskId,
        sourceTitle: source.title,
        requesterName: source.requester.displayName,
      },
      openQuestions: [],
      createdAt: now,
      updatedAt: now,
    };
    const event = makeTaskEvent(
      { ...task, version: 0 },
      {
        type: "task.created",
        payload: { title, instruction, originInputId: source.originInputId },
      },
      now,
      { eventId: taskEventIdFor(taskId, 1) },
    );
    return { createdTasks: [{ ownerId: stored.ownerId, task, event }] };
  });

  return { offerFor };
});

/** Asks about a proposal and settles its answer; used by the dispatcher. */
export const makeSkillProposalAnswers = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const ledger = yield* ChannelLedger.ChannelLedger;
  const { path, files, skillPath } = yield* skillFiles;
  // With the owner token, unique per save attempt across processes; a temp file is never reopened.
  const attempts = yield* Ref.make(0);

  /** What is at the skill's path now: these exact bytes, another file, or nothing. */
  const found = (target: string, bytes: Uint8Array) =>
    fs.stat(target).pipe(
      Effect.flatMap((info) =>
        Number(info.size) !== bytes.length
          ? Effect.succeed("taken" as const)
          : fs
              .readFile(target)
              .pipe(
                Effect.map((read) =>
                  sameBytes(read, bytes) ? ("saved" as const) : ("taken" as const),
                ),
              ),
      ),
      Effect.catchTags({
        PlatformError: (cause) =>
          Effect.succeed(
            cause.reason._tag === "NotFound" ? ("missing" as const) : ("failed" as const),
          ),
      }),
    );

  /**
   * Links the prepared file into place. Without a prepared file (it could not be written), an
   * earlier attempt's link may still be there, so the path decides.
   */
  const place = (tmp: string | undefined, target: string, bytes: Uint8Array) =>
    (tmp === undefined
      ? found(target, bytes)
      : fs.link(tmp, target).pipe(
          Effect.as("saved" as const),
          Effect.catchTags({
            PlatformError: (cause) =>
              cause.reason._tag === "AlreadyExists"
                ? found(target, bytes)
                : Effect.succeed("failed" as const),
          }),
        )
    ).pipe(Effect.map((outcome) => (outcome === "missing" ? ("failed" as const) : outcome)));

  const sweep = Effect.gen(function* () {
    const names = yield* fs.readDirectory(files.skills).pipe(Effect.orElseSucceed(() => []));
    for (const name of names.filter((entry) => tmpPattern.test(entry)).slice(0, SWEEP_LIMIT)) {
      const encoded = tmpPattern.exec(name)?.[1];
      if (encoded === undefined) continue;
      const task = yield* ledger.getTask(
        ChannelTaskId.make(encoded.replace("channel-task-", "channel-task:")),
      );
      if (task === undefined || TERMINAL.has(task.task.status))
        yield* fs.remove(path.join(files.skills, name)).pipe(Effect.ignore);
    }
  });

  const resolve = Effect.fn("ChannelSkillProposals.resolve")(function* (
    stored: ChannelLedger.ChannelStoredTask,
    owner: string,
    answer: Answer,
  ): Effect.fn.Return<void, ChannelLedger.ChannelLedgerError> {
    const proposal = stored.task.skillProposal;
    if (proposal === undefined) return;
    const save = answer.payload.answer.trim() === SKILL_PROPOSAL_SAVE;
    const target = skillPath(proposal.name);
    const bytes = new TextEncoder().encode(
      skillFileText({ taskId: stored.task.taskId, proposal, approvedAt: answer.occurredAt }),
    );
    const attempt = yield* Ref.getAndUpdate(attempts, (count) => count + 1);
    const unique = owner.toLowerCase().replace(/[^a-z0-9]+/gu, "-") + "-" + attempt;
    const tmp = path.join(
      files.skills,
      "." + proposal.name + ".md." + stored.task.taskId.replace(":", "-") + "." + unique + ".tmp",
    );
    const prepared = save
      ? yield* fs.makeDirectory(files.skills, { recursive: true }).pipe(
          Effect.andThen(fs.writeFile(tmp, bytes, { flag: "wx" })),
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        )
      : false;
    yield* ledger
      .underWorkerLock(
        owner,
        Effect.gen(function* () {
          const current = yield* ledger.getTask(stored.task.taskId);
          if (
            current === undefined ||
            current.task.status !== "received" ||
            current.task.version !== stored.task.version ||
            current.task.openQuestions.length > 0
          )
            return;
          const outcome = save
            ? yield* place(prepared ? tmp : undefined, target, bytes)
            : "declined";
          const summary =
            outcome === "saved"
              ? "Saved the skill " + proposal.name + "."
              : outcome === "taken"
                ? "A skill named " + proposal.name + " already exists, so nothing was saved."
                : outcome === "failed"
                  ? "Couldn't save the skill " + proposal.name + "; nothing was written."
                  : "Not saved.";
          yield* commitTransition(
            ledger,
            current,
            { type: "task.completed", payload: { generation: current.task.generation, summary } },
            { owner, narrate: true },
          );
        }),
      )
      .pipe(Effect.ensuring(save ? fs.remove(tmp).pipe(Effect.ignore) : Effect.void));
    if (save) yield* sweep;
  });

  /** One step for a proposal task the dispatcher picked up: ask, or settle the recorded answer. */
  const advance = Effect.fn("ChannelSkillProposals.advance")(function* (
    stored: ChannelLedger.ChannelStoredTask,
    owner: string,
  ): Effect.fn.Return<void, ChannelLedger.ChannelLedgerError> {
    const proposal = stored.task.skillProposal;
    if (
      proposal === undefined ||
      stored.task.status !== "received" ||
      stored.task.openQuestions.length > 0
    )
      return;
    const answer = (yield* ledger.recentAnswers(stored.task.taskId, 1))[0];
    if (answer !== undefined) {
      yield* resolve(stored, owner, answer);
      return;
    }
    yield* commitTransition(
      ledger,
      stored,
      {
        type: "task.question.opened",
        payload: {
          question: {
            questionId: questionIdFor(stored.task.taskId, stored.task.version + 1),
            text: skillProposalQuestion(proposal),
            askedAt: DateTime.formatIso(yield* DateTime.now),
            options: [...SKILL_PROPOSAL_OPTIONS],
            ...(stored.task.requester.externalActorId === undefined
              ? {}
              : { requesterExternalActorId: stored.task.requester.externalActorId }),
          },
        },
      },
      { owner, narrate: true },
    );
  });

  return { advance };
});
