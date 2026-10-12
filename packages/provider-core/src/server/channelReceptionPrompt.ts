/**
 * The prompt and output contract for one channel reception pass.
 *
 * The model returns a flat object with every key present (unused ones empty), which every
 * provider's structured output accepts. `toChannelReceptionResult` turns it into the typed
 * contract result; the ledger then validates ids, targets, and permissions before acting.
 *
 * @module channelReceptionPrompt
 */
import {
  CHANNEL_RECEPTION_MAX_OPTIONS,
  ChannelReceptionResult,
  type ChannelReceptionInput,
} from "@goat/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { limitSection } from "./textGenerationUtils.ts";

export const ChannelReceptionModelOutput = Schema.Struct({
  replyText: Schema.String,
  action: Schema.Literals(["create_task", "status", "answer_question", "clarify", "report_only"]),
  title: Schema.String,
  instruction: Schema.String,
  projectId: Schema.String,
  host: Schema.String,
  taskId: Schema.String,
  questionId: Schema.String,
  answer: Schema.String,
  question: Schema.String,
  options: Schema.Array(Schema.String),
});
export type ChannelReceptionModelOutput = typeof ChannelReceptionModelOutput.Type;

const decodeResult = Schema.decodeUnknownOption(ChannelReceptionResult);

/** Distinct, non-empty choices, at most CHANNEL_RECEPTION_MAX_OPTIONS of them. */
function clarifyOptions(options: ReadonlyArray<string>): string[] {
  const seen = new Set<string>();
  for (const option of options) {
    const trimmed = option.trim();
    if (trimmed !== "") seen.add(trimmed);
  }
  return [...seen].slice(0, CHANNEL_RECEPTION_MAX_OPTIONS);
}

/** The typed result, or None when the model's choice is missing what its action needs. */
export function toChannelReceptionResult(
  output: ChannelReceptionModelOutput,
): Option.Option<ChannelReceptionResult> {
  const replyText = output.replyText.trim();
  switch (output.action) {
    case "create_task":
      return decodeResult({
        replyText,
        action: {
          type: "create_task",
          title: output.title,
          instruction: output.instruction,
          ...(output.projectId.trim() === "" ? {} : { projectId: output.projectId }),
          ...(output.host.trim() === "" ? {} : { host: output.host.trim() }),
        },
      });
    case "status":
      return decodeResult({
        replyText,
        action: {
          type: "status",
          ...(output.taskId.trim() === "" ? {} : { taskId: output.taskId }),
        },
      });
    case "answer_question":
      return decodeResult({
        replyText,
        action: {
          type: "answer_question",
          taskId: output.taskId,
          questionId: output.questionId,
          answer: output.answer,
        },
      });
    case "clarify": {
      const options = clarifyOptions(output.options);
      return decodeResult({
        replyText,
        action: {
          type: "clarify",
          question: output.question,
          ...(options.length < 2 ? {} : { options }),
        },
      });
    }
    case "report_only":
      return decodeResult({ replyText, action: { type: "report_only" } });
  }
}

export function buildChannelReceptionPrompt(input: ChannelReceptionInput) {
  const tail = input.tail
    .map((entry) => (entry.role === "user" ? "Person: " : "GOAT: ") + entry.text)
    .join("\n");
  const tasks = input.tasks
    .map((task) => {
      const questions = task.openQuestions
        .map((question) => "    open question " + question.questionId + ": " + question.text)
        .join("\n");
      return (
        "- task " +
        task.taskId +
        " [" +
        task.status +
        "] " +
        task.title +
        (task.resultSummary === undefined ? "" : " — " + task.resultSummary) +
        (questions === "" ? "" : "\n" + questions)
      );
    })
    .join("\n");
  const projects = input.allowedTargets
    .map((target) => "- project " + target.projectId + ": " + target.label)
    .join("\n");
  const hosts = (input.allowedHosts ?? []).map((host) => "- " + host).join("\n");
  const threads = (input.recentThreads ?? [])
    .map(
      (thread) =>
        "- " +
        thread.title +
        (thread.project === undefined ? "" : " (" + thread.project + ")") +
        (thread.working ? " [working]" : ""),
    )
    .join("\n");
  const subject =
    input.mode === "input"
      ? "New message from " +
        input.requester.displayName +
        ":\n" +
        limitSection(input.inputText ?? "", 8_000)
      : "Task update to tell the requester about (" +
        (input.taskEvent?.type ?? "") +
        "):\n" +
        limitSection(input.taskEvent?.summary ?? "", 8_000);

  const prompt = [
    "You are GOAT's front desk. You answer one message right away and decide what happens next.",
    "You do not run tools or read files yourself; for work, you start a coding agent that does.",
    "Reply in one to three short sentences.",
    "Your reply describes the action you choose. With create_task, say a coding agent is starting on it; never say you cannot do it or cannot check.",
    "Never say work is finished unless the update says it is.",
    "When answering takes more than this conversation, such as checking a project, repository, thread, or anything not listed below, reply now that you are starting on it and choose create_task. Do not make the person wait or ask them which work they mean first.",
    "",
    "Choose exactly one action:",
    "- create_task: the person asks for new work, or asks something you can only answer by looking it up. Fill title (short) and instruction (complete, self-contained). Set projectId only to one listed below. Set host only when the person asks for the work to run on one of the other machines listed below.",
    "- status: the person asks about work listed below in this conversation. Set taskId when one task is meant.",
    "- answer_question: the message answers one listed open question. Fill taskId, questionId, answer.",
    "- clarify: only when the message is too unclear to start any work, or it could mean several listed tasks or recent threads. Fill question and put the same question in replyText. When the answer is one of a few concrete choices, such as a task, a recent thread, or a project listed below, put two to four of them in options, each worded as the person's short reply. Otherwise leave options empty.",
    "- report_only: anything else, and always for task updates.",
    "",
    "Return a JSON object with every key: replyText, action, title, instruction, projectId, host, taskId, questionId, answer, question, options. Use an empty string for text keys the action does not use and an empty list for options unless the action is clarify.",
    "",
    "Projects work can go to:",
    projects === "" ? "(none listed)" : projects,
    "",
    "Other machines work can run on (host):",
    hosts === "" ? "(none)" : hosts,
    "",
    "Work in this conversation:",
    tasks === "" ? "(none)" : tasks,
    "",
    "Recently active threads (titles only; you cannot read their contents):",
    threads === "" ? "(none)" : threads,
    "",
    "Recent conversation:",
    tail === "" ? "(none)" : limitSection(tail, 16_000),
    "",
    subject,
    "",
    // Last, so the language follows the person rather than the environment the model runs in.
    input.mode === "input"
      ? "Write replyText in the same language as the new message above."
      : "Write replyText in the language the person used in the recent conversation, not the language of the update. Say only what the update says happened.",
  ].join("\n");

  return { prompt, outputSchema: ChannelReceptionModelOutput };
}
