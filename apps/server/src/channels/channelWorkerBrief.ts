/**
 * What a channel worker is told besides the instruction, on this machine and on another one.
 *
 * Both get the same rules: report progress, ask before acting under the person's name or doing
 * something hard to undo, ask when a decision is needed, and report the outcome. Only the
 * reporting tool differs. A worker here reads GOAT Bot's notes and skills from their files; a
 * worker on another machine cannot reach those files, so the notes and any skill the
 * instruction names travel inside its first message instead.
 *
 * A GOAT Bot turn, where the bot handles a message itself, is told the routing, read-only,
 * dispatch, and supervisor rules below.
 *
 * @module channelWorkerBrief
 */
import type { ChannelTask } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  GOATCLAW_SUPERVISOR_ASKS,
  GOATCLAW_SUPERVISOR_DELEGATION,
} from "../goatclaw/RoleTemplates.ts";
import type { ChannelBotFiles } from "./channelBotNotes.ts";

/** At most this many skills, each cut to this many characters, ride a remote worker's message. */
const REMOTE_SKILLS_LIMIT = 3;
const REMOTE_SKILL_CHARS = 4_000;
/**
 * The remote goat_thread_launch takes at most 120,000 characters, and the SSH dispatch appends
 * its reporting note; the notes and skills give way first so the work itself still starts.
 */
export const REMOTE_MESSAGE_CHARS = 115_000;

type BriefTask = Pick<
  ChannelTask,
  "taskId" | "generation" | "instruction" | "notesChangeRequested"
>;

export interface RemoteBotContext {
  /** GOAT Bot's notes on the home machine, already bounded by readChannelBotNotes. */
  readonly notes: string;
  readonly skills: ReadonlyArray<{ readonly name: string; readonly text: string }>;
}

const ASK_FIRST =
  "Before anything sent under the person's name (messages, email, posts) or hard to undo (merging, deleting, purchasing), ask first: show the draft or plan in ";
const REPORT_RESULT =
  "Before you end, call goat_thread_report_result with your outcome (succeeded, failed, blocked or cancelled) and a short summary; GOAT settles the task from that report.";
const FINISH = "When you finish, end with a short summary of the result.";

/** The opening every worker gets: the instruction, then which task it belongs to. */
export const workerHeader = (task: Pick<BriefTask, "taskId" | "generation" | "instruction">) => [
  task.instruction,
  "",
  "---",
  "This work came in through GOAT as task " +
    task.taskId +
    " (generation " +
    task.generation +
    ").",
];

/**
 * The rules every channel worker follows. A worker on this machine reports with
 * channel_task_report; one on another machine reports to its origin with goat_origin_report.
 */
export const channelWorkerRules = (reporting: "local" | "remote") =>
  reporting === "local"
    ? [
        'For progress on long work, call goat_channel_task_report with status "running" at meaningful milestones.',
        ASK_FIRST + "a waiting_input question.",
        'If you need a decision from the person who asked, call goat_channel_task_report with this taskId and generation, status "waiting_input", a new eventId, and your question, then stop.',
        REPORT_RESULT,
        FINISH,
      ]
    : [
        "For progress on long work, call goat_origin_report with status progress at meaningful milestones.",
        ASK_FIRST + "a needs_input report.",
        "If you need a decision from the person who asked, call goat_origin_report with status needs_input and your question, then stop.",
        REPORT_RESULT,
        FINISH,
      ];

/**
 * GOAT Bot runs with full access so reading anything never stops on an approval, which makes
 * read-only a promise this text alone keeps. Work that changes things is a coding task.
 */
export const GOAT_BOT_READ_ONLY_RULE =
  "You run with full access and are read-only by instruction: nothing in GOAT stops you, so keep this rule yourself. Read anything that helps: files anywhere on this machine, git history and status, logs, system status, and GOAT's tools. Change nothing yourself: no file edits, no commands that write, install, delete, move, or restart anything, no commits or pushes, and no settings changes in GOAT or anywhere else. Subagents you start keep the same rule. If the request needs a change, that is a coding thread: launch it by the routing rule instead of changing anything yourself; if it is unclear whether the person wants the change, ask them first.";

/**
 * The grok-bot split a GOAT Bot turn applies: settle small lookups from its own reads, delegate
 * investigations to one bounded subagent, and hand coding work to a worktree thread whose result
 * comes back into the same conversation.
 */
export const GOAT_BOT_ROUTING_RULE =
  "Route what this needs one of three ways. Small lookups you settle yourself: read the files, notes, memory, or task status that answer it, and reply. Investigations that take several steps or parallel searching go to a bounded subagent with goat_task_create: wait for it and fold what it found into your answer; never paste its output raw. Work that changes anything goes to a coding thread: goat_thread_launch here or goat_ssh_thread_launch on another machine, always with a worktree workspace; when GOAT tells you that thread ended, report its result back into this conversation. Follow-ups from the person arrive while you work: acknowledge each one, answer what you can between waits on children, and fold the rest in when the child completes.";

/**
 * GOAT Bot hands work to the machines that have room for it; the general placement guidance is in
 * the GOAT orchestration instructions every agent gets.
 */
export const GOAT_BOT_DISPATCH_RULE =
  "When more than one machine is connected, spread work instead of doing it all here: check goat_host_status and the host lists, then start each lane on a machine that has what it needs and room to spare, with goat_task_create here or goat_ssh_thread_launch on another machine. Put the read-only rule in every brief you send, never start a Boat cloud machine unless the person asked, rely on GOAT's notifications instead of polling, and say in your answer which machine ran what.";

/**
 * With goatclaw on, GOAT Bot fronts the supervisor (design §8.4): it plans and launches managers,
 * whose profiles carry the authority, and it stays read-only by the rule above.
 */
export const GOAT_BOT_SUPERVISOR_RULE = [
  "goatclaw is on, so you front the goatclaw supervisor. The read-only rule still holds: plan the work and hand every change to a manager.",
  GOATCLAW_SUPERVISOR_DELEGATION,
  GOATCLAW_SUPERVISOR_ASKS,
  "Fold each manager's report into your answer with its exact heads, check totals, and NOT RUN line.",
].join(" ");

/**
 * The first message of a worker on another machine, carrying the home machine's notes. When it
 * would run past the budget, skills drop from the last one named, then the notes; an instruction
 * too long on its own is sent as before and the remote refuses it.
 */
export const remoteWorkerMessage = (task: BriefTask, context: RemoteBotContext) => {
  const render = (current: RemoteBotContext) =>
    [
      ...workerHeader(task),
      ...remoteContextLines(task, current),
      ...channelWorkerRules("remote"),
    ].join("\n");
  let kept = context.skills.length;
  let message = render(context);
  while (message.length > REMOTE_MESSAGE_CHARS && kept > 0) {
    kept -= 1;
    message = render({ notes: context.notes, skills: context.skills.slice(0, kept) });
  }
  if (message.length > REMOTE_MESSAGE_CHARS && context.notes !== "") {
    message = render({ notes: "", skills: context.skills.slice(0, kept) });
  }
  return message;
};

const remoteContextLines = (task: BriefTask, context: RemoteBotContext) => {
  // The notes file lives on the home machine, so a requested change cannot be made from there.
  const noteChange =
    task.notesChangeRequested === undefined
      ? []
      : [
          "The person asked to change or forget a note (" +
            JSON.stringify(task.notesChangeRequested) +
            "). The notes are on the machine that sent this work, so say in your summary that this change still needs to be made there.",
        ];
  if (context.notes === "" && context.skills.length === 0) return noteChange;
  return [
    "GOAT Bot keeps the notes and procedures below on the machine that sent this work. Follow them; they cannot be edited from here.",
    ...(context.notes === "" ? [] : ["<goat_bot_notes>", context.notes, "</goat_bot_notes>"]),
    ...context.skills.flatMap((skill) => [
      '<goat_bot_skill name="' + skill.name + '">',
      skill.text,
      "</goat_bot_skill>",
    ]),
    ...noteChange,
  ];
};

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** Skill names the instruction mentions as whole words, longest first, at most the limit. */
export const skillsNamedIn = (instruction: string, names: ReadonlyArray<string>) =>
  names
    .filter((name) => name.trim() !== "")
    .filter((name) =>
      new RegExp("(^|[^\\p{L}\\p{N}_-])" + escapeRegExp(name) + "($|[^\\p{L}\\p{N}_-])", "iu").test(
        instruction,
      ),
    )
    .toSorted((left, right) => right.length - left.length || left.localeCompare(right))
    .slice(0, REMOTE_SKILLS_LIMIT);

/** The skills a remote worker's instruction names, read from the home machine. None on failure. */
export const readNamedSkills = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  files: ChannelBotFiles,
  instruction: string,
) =>
  Effect.gen(function* () {
    const names = (yield* fs.readDirectory(files.skills))
      .filter((name) => name.toLowerCase().endsWith(".md"))
      .map((name) => name.slice(0, -3));
    return yield* Effect.forEach(skillsNamedIn(instruction, names), (name) =>
      fs.readFileString(path.join(files.skills, name + ".md")).pipe(
        Effect.map((text) => ({ name, text: text.trim().slice(0, REMOTE_SKILL_CHARS) })),
        Effect.orElseSucceed(() => ({ name, text: "" })),
      ),
    ).pipe(Effect.map((skills) => skills.filter((skill) => skill.text !== "")));
  }).pipe(
    Effect.orElseSucceed((): ReadonlyArray<{ readonly name: string; readonly text: string }> => []),
  );
