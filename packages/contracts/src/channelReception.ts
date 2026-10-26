import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  ChannelConversationId,
  ChannelKind,
  ChannelQuestionId,
  ChannelRequester,
  ChannelTaskId,
} from "./channelCommon.ts";
import {
  ChannelDispatchTarget,
  ChannelTaskEventType,
  ChannelTaskKind,
  ChannelTaskStatus,
} from "./channelLedger.ts";

/**
 * Input and output of one reception pass: a short, tool-free text generation that answers a
 * channel message or turns a task event into words for the requester. It reads a bounded tail
 * of its own conversation and the related ledger tasks, never other conversations.
 */

export const ChannelReceptionMode = Schema.Literals(["input", "task_event"]);
export type ChannelReceptionMode = typeof ChannelReceptionMode.Type;

export const ChannelReceptionTailMessage = Schema.Struct({
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String,
  at: IsoDateTime,
});
export type ChannelReceptionTailMessage = typeof ChannelReceptionTailMessage.Type;

export const ChannelReceptionTaskSummary = Schema.Struct({
  taskId: ChannelTaskId,
  kind: Schema.optional(ChannelTaskKind),
  title: TrimmedNonEmptyString,
  status: ChannelTaskStatus,
  resultSummary: Schema.optional(Schema.String),
  /** The machine the work runs on when it is not this one. */
  host: Schema.optional(TrimmedNonEmptyString),
  /** Pull requests the worker linked, as "repo#123 (merged)". */
  pullRequests: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  /** Separate summaries of agent-reported tests and the host-observed check. */
  evidence: Schema.optional(Schema.Array(Schema.String)),
  openQuestions: Schema.Array(
    Schema.Struct({ questionId: ChannelQuestionId, text: TrimmedNonEmptyString }),
  ),
});
export type ChannelReceptionTaskSummary = typeof ChannelReceptionTaskSummary.Type;

export const ChannelReceptionTaskEvent = Schema.Struct({
  taskId: ChannelTaskId,
  type: ChannelTaskEventType,
  summary: Schema.String,
});
export type ChannelReceptionTaskEvent = typeof ChannelReceptionTaskEvent.Type;

/** A place the requester may send work, offered to the model as a choice by id. */
export const ChannelReceptionTargetOption = Schema.Struct({
  projectId: ProjectId,
  label: TrimmedNonEmptyString,
});
export type ChannelReceptionTargetOption = typeof ChannelReceptionTargetOption.Type;

/** A recently active thread, so the model can name it in a reply or offer it as a choice. */
export const ChannelReceptionThreadSummary = Schema.Struct({
  title: TrimmedNonEmptyString,
  project: Schema.optional(TrimmedNonEmptyString),
  working: Schema.Boolean,
});
export type ChannelReceptionThreadSummary = typeof ChannelReceptionThreadSummary.Type;

/** One fact about the machine reception runs on, such as its name, OS, or memory. */
export const ChannelReceptionHostFact = Schema.Struct({
  label: TrimmedNonEmptyString,
  value: TrimmedNonEmptyString,
});
export type ChannelReceptionHostFact = typeof ChannelReceptionHostFact.Type;

/** A written procedure in the bot's skills folder, offered by name. */
export const ChannelReceptionSkill = Schema.Struct({
  name: TrimmedNonEmptyString,
  summary: Schema.String,
});
export type ChannelReceptionSkill = typeof ChannelReceptionSkill.Type;

/**
 * What a reception pass can look up before it answers. The server runs each read within what the
 * requester may see and hands the results to one more pass; reads never change anything.
 * - memory: GOAT Bot's notes and journal, and GOAT memory when the requester may read it.
 * - work: tasks GOAT Bot started (any conversation the requester may see), their results,
 *   final reports and pull requests.
 * - thread: the latest messages of a task's coding thread.
 * - conversation: older messages of this conversation than the recent ones shown.
 */
export const ChannelReceptionReadKind = Schema.Literals([
  "memory",
  "work",
  "thread",
  "conversation",
  "pending",
]);
export type ChannelReceptionReadKind = typeof ChannelReceptionReadKind.Type;

export const ChannelReceptionRead = Schema.Struct({
  kind: ChannelReceptionReadKind,
  /** Words to look for, or a task id, thread title, or pull request number or URL. */
  query: TrimmedNonEmptyString,
});
export type ChannelReceptionRead = typeof ChannelReceptionRead.Type;

export const ChannelReceptionReadResult = Schema.Struct({
  kind: ChannelReceptionReadKind,
  query: Schema.String,
  text: Schema.String,
});
export type ChannelReceptionReadResult = typeof ChannelReceptionReadResult.Type;

/** The most reads one pass may ask for; one round of reads per input. */
export const CHANNEL_RECEPTION_MAX_READS = 3;

/** The most choices a clarifying question offers. */
export const CHANNEL_RECEPTION_MAX_OPTIONS = 4;

/**
 * The label of the bot's own workspace when it is offered as a target: work about the machine
 * itself, or anything not tied to a repository, runs there.
 */
export const CHANNEL_HOST_WORKSPACE_LABEL = "This machine (no project)";

export const ChannelReceptionInput = Schema.Struct({
  mode: ChannelReceptionMode,
  conversationId: ChannelConversationId,
  originKind: ChannelKind,
  /** The message being answered, in `input` mode. */
  inputText: Schema.optional(Schema.String),
  /** The ledger change being reported, in `task_event` mode. */
  taskEvent: Schema.optional(ChannelReceptionTaskEvent),
  tail: Schema.Array(ChannelReceptionTailMessage),
  tasks: Schema.Array(ChannelReceptionTaskSummary),
  allowedTargets: Schema.Array(ChannelReceptionTargetOption),
  /** Other machines (SSH aliases) the requester may send work to. */
  allowedHosts: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  /** Titles of the requester's most recently active threads, newest first. */
  recentThreads: Schema.optional(Schema.Array(ChannelReceptionThreadSummary)),
  /** Facts about this machine, so questions about it are answered without starting work. */
  hostFacts: Schema.optional(Schema.Array(ChannelReceptionHostFact)),
  /** Standing notes the people using the bot asked it to keep, newest last. */
  notes: Schema.optional(Schema.String),
  /** The newest lines of GOAT Bot's journal of work it started and how it ended. */
  journal: Schema.optional(Schema.String),
  /** Whether this pass may answer with a read; false on the pass that already has results. */
  readsAllowed: Schema.optional(Schema.Boolean),
  /** Results of the reads the previous pass asked for. */
  readResults: Schema.optional(Schema.Array(ChannelReceptionReadResult)),
  /** Written procedures workers can follow. */
  skills: Schema.optional(Schema.Array(ChannelReceptionSkill)),
  requester: ChannelRequester,
});
export type ChannelReceptionInput = typeof ChannelReceptionInput.Type;

/**
 * What the model decided. The ledger validates every id, target, and permission in it before
 * anything happens; the model cannot pick a task, project, or mode the requester may not use.
 */
export const ChannelReceptionAction = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("create_task"),
    title: TrimmedNonEmptyString,
    instruction: TrimmedNonEmptyString,
    projectId: Schema.optional(ProjectId),
    /** One of `allowedHosts`, when the person asked for another machine. */
    host: Schema.optional(TrimmedNonEmptyString),
    requestedTarget: Schema.optional(ChannelDispatchTarget),
    /**
     * The person's words in the current input asking the work to change or forget a standing
     * note. The server keeps it only when it occurs in that input; only such tasks may edit notes.
     */
    notesChangeRequested: Schema.optional(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    type: Schema.Literal("read"),
    reads: Schema.Array(ChannelReceptionRead).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(CHANNEL_RECEPTION_MAX_READS),
    ),
  }),
  Schema.Struct({
    /**
     * GOAT Bot looks into the message itself with tools (reading files and notes, checking
     * threads, research through subagents) and answers when done. Never changes a repository.
     */
    type: Schema.Literal("run_turn"),
    title: TrimmedNonEmptyString,
    instruction: TrimmedNonEmptyString,
    /** As on create_task: only a turn the person asked to change a note may edit the notes. */
    notesChangeRequested: Schema.optional(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    type: Schema.Literal("move_task"),
    taskId: ChannelTaskId,
    host: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    /** The message adds to or corrects running work listed in this conversation; it joins it. */
    type: Schema.Literal("follow_up"),
    taskId: ChannelTaskId,
  }),
  Schema.Struct({
    /**
     * Stop work: the one task named, or, with no taskId, every open piece of work the person may
     * stop. Workers and the subagents they started are stopped too.
     */
    type: Schema.Literal("stop_work"),
    taskId: Schema.optional(ChannelTaskId),
  }),
  Schema.Struct({
    type: Schema.Literal("status"),
    taskId: Schema.optional(ChannelTaskId),
  }),
  Schema.Struct({
    type: Schema.Literal("answer_question"),
    taskId: ChannelTaskId,
    questionId: ChannelQuestionId,
    answer: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("clarify"),
    question: TrimmedNonEmptyString,
    /** Short answers the person can pick instead of typing one. */
    options: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
    /** The question picks a project; the server words it from the projects it would offer. */
    about: Schema.optional(Schema.Literal("project")),
  }),
  Schema.Struct({ type: Schema.Literal("report_only") }),
]);
export type ChannelReceptionAction = typeof ChannelReceptionAction.Type;

export const ChannelReceptionResult = Schema.Struct({
  replyText: TrimmedNonEmptyString,
  action: ChannelReceptionAction,
  /** A lasting rule or fact the person asked the bot to keep, added to its notes. */
  remember: Schema.optional(TrimmedNonEmptyString),
  /**
   * The person's words in the current input that ask for `remember`. The server saves the note
   * only when this occurs in that input from a person; otherwise it drops the note.
   */
  rememberQuote: Schema.optional(TrimmedNonEmptyString),
});
export type ChannelReceptionResult = typeof ChannelReceptionResult.Type;

/** Bounds on the conversation tail a reception pass reads. */
export const CHANNEL_RECEPTION_TAIL_LIMITS = {
  messages: 20,
  bytes: 16 * 1024,
} as const;
