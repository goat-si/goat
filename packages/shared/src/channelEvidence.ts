import type { ChannelWorkerResult } from "@goat/contracts";

/** Labels keep the agent's claim separate from the command GOAT actually observed. */
export function channelEvidenceLabels(
  result: ChannelWorkerResult | undefined,
): ReadonlyArray<string> {
  if (result === undefined) return [];
  const reported =
    result.tests === undefined
      ? "Reported tests: not reported"
      : result.tests.ok
        ? "Reported tests: passed"
        : "Reported tests: failed";
  const check = result.observedCheck;
  if (check === undefined)
    return [
      reported,
      result.observedCheckPending === true
        ? "GOAT check: pending"
        : result.observedCheckPending === false
          ? "GOAT check: not run"
          : "GOAT check: not available",
    ];
  let observed: string;
  switch (check.status) {
    case "running":
      observed = "running";
      break;
    case "completed":
      observed =
        check.exitCode === null
          ? "finished without an exit code"
          : check.exitCode === 0
            ? "passed"
            : `failed (exit ${check.exitCode})`;
      break;
    case "timed_out":
      observed = "timed out";
      break;
    case "interrupted":
      observed = "interrupted";
      break;
    case "skipped":
      observed =
        check.skipReason === "shared-checkout"
          ? "skipped (shared checkout)"
          : check.skipReason === "worktree-missing"
            ? "skipped (worktree missing)"
            : "skipped";
      break;
  }
  return [reported, `GOAT check: ${observed}`];
}
