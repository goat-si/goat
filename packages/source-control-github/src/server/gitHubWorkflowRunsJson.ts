import * as Result from "effect/Result";

import {
  decodeWorkflowRuns,
  trimmed,
  type DecodeFailure,
  type GitHubWorkflowRunApproval,
} from "./gitHubPullRequestJson.ts";

// Approval-gated runs (action_required) are read separately as action-required checks.
const UNFINISHED_WORKFLOW_RUN_STATUSES = new Set([
  "requested",
  "queued",
  "pending",
  "waiting",
  "in_progress",
]);

/** Workflow runs GitHub has not finished, which may have no check runs on the head yet. */
export function decodeUnfinishedWorkflowRunsJson(
  raw: string,
): Result.Result<ReadonlyArray<GitHubWorkflowRunApproval>, DecodeFailure> {
  const decoded = decodeWorkflowRuns(raw);
  if (!Result.isSuccess(decoded)) return Result.fail(decoded.failure);
  return Result.succeed(
    decoded.success.workflow_runs
      .filter((run) => UNFINISHED_WORKFLOW_RUN_STATUSES.has(run.status ?? ""))
      .map((run) => ({
        id: run.id,
        name: trimmed(run.name) ?? `Workflow run ${run.id}`,
        url: trimmed(run.html_url),
      })),
  );
}
