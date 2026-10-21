/**
 * What a channel worker is told besides the instruction, on this machine and on another one.
 *
 * Both get the same rules: report progress, ask before acting under the person's name or doing
 * something hard to undo, ask when a decision is needed, and report the outcome. Only the
 * reporting tool differs. A worker here reads GOAT Bot's notes and skills from their files; a
 * worker on another machine cannot reach those files, so the notes and any skill the
 * instruction names travel inside its first message instead.
 *
 * @module channelWorkerBrief
 */
import type { ChannelTask } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

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
        'For progress on long work, call channel_task_report with status "running" at meaningful milestones.',
        ASK_FIRST + "a waiting_input question.",
        'If you need a decision from the person who asked, call channel_task_report with this taskId and generation, status "waiting_input", a new eventId, and your question, then stop.',
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
