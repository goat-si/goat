/**
 * The prompt and output contract for one channel reception pass.
 *
 * The model returns a flat object with every key present (unused ones empty), which every
 * provider's structured output accepts. `toChannelReceptionResult` turns it into the typed
 * contract result; the ledger then validates ids, targets, and permissions before acting.
 *
 * @module channelReceptionPrompt
 */
import { ChannelReceptionResult, type ChannelReceptionInput } from "@t3tools/contracts";
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
});
export type ChannelReceptionModelOutput = typeof ChannelReceptionModelOutput.Type;

const decodeResult = Schema.decodeUnknownOption(ChannelReceptionResult);

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
    case "clarify":
      return decodeResult({ replyText, action: { type: "clarify", question: output.question } });
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
    "You cannot run tools, read files, or do the work yourself. Coding agents do the work.",
    "Reply in the same language as the person, in one to three short sentences.",
    "Never say work is finished unless the update says it is.",
    "",
    "Choose exactly one action:",
    "- create_task: the person asks for new work. Fill title (short) and instruction (complete, self-contained). Set projectId only to one listed below. Set host only when the person asks for the work to run on one of the other machines listed below.",
    "- status: the person asks about existing work. Set taskId when one task is meant.",
    "- answer_question: the message answers one listed open question. Fill taskId, questionId, answer.",
    "- clarify: you cannot tell what is wanted or which task is meant. Fill question.",
    "- report_only: anything else, and always for task updates.",
    "",
    "Return a JSON object with every key: replyText, action, title, instruction, projectId, host, taskId, questionId, answer, question. Use an empty string for keys the action does not use.",
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
    "Recent conversation:",
    tail === "" ? "(none)" : limitSection(tail, 16_000),
    "",
    subject,
  ].join("\n");

  return { prompt, outputSchema: ChannelReceptionModelOutput };
}
