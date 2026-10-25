/** The message a goal's worker starts with, from the goal's prompt template. */
import type { FleetGoal } from "@goat/contracts";
import { goatCallText } from "@goat/contracts/agentSurface/callText";

import { branchFor, targetKey } from "./goalPlan.ts";
import type { WorkerRecord } from "./GoalStore.ts";

export const renderPrompt = (goal: FleetGoal, worker: WorkerRecord, branch: string) => {
  const target = goal.spec.workers.perTarget ? goal.spec.targets[worker.slot] : undefined;
  const targetText =
    target === undefined
      ? goal.spec.targets.map(targetKey).join(", ")
      : target.type === "prompt"
        ? target.text
        : target.type === "issue"
          ? "issue #" + target.number
          : target.type === "pull_request"
            ? "pull request #" + target.number
            : "branch " + target.name;
  const body = goal.spec.workers.promptTemplate
    .replaceAll("{{target}}", targetText)
    .replaceAll("{{branch}}", branch)
    .replaceAll("{{attempt}}", String(worker.attempt))
    .replaceAll(
      "{{previousAttempt}}",
      worker.attempt > 1 ? branchFor(goal, worker.slot, worker.attempt - 1) : "",
    );
  return (
    body +
    "\n\nYou are slot " +
    worker.slot +
    " (attempt " +
    worker.attempt +
    ") of GOAT goal " +
    goal.id +
    `. When you finish, report with ${goatCallText("thread.report_result")}, including any pull request you opened.`
  );
};
