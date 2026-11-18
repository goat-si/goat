import type { ThreadId, WorktreeSetupSnapshot } from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import { parseGitCloneProgressLine } from "../../project/gitCloneProgress.ts";
import type * as WorktreeSetupTracker from "../../project/WorktreeSetupTracker.ts";

/** createWorktree's submodule callbacks, shown as the worktree setup card's own step. */
export const submoduleProgress = (
  setupTracker: WorktreeSetupTracker.WorktreeSetupTracker["Service"],
  threadId: ThreadId,
) => {
  let reportedAt = Number.NEGATIVE_INFINITY;
  return {
    onSubmodulesStarted: () =>
      setupTracker
        .stageStatus(threadId, "checkout", "done")
        .pipe(Effect.andThen(setupTracker.stageStatus(threadId, "submodules", "running"))),
    onSubmodulesDisabled: ({ source }: { readonly source: string }) =>
      setupTracker.stageStatus(threadId, "submodules", "skipped", `disabled in ${source}`),
    onSubmoduleLine: (line: string) => {
      // Paths may contain quotes; git closes the path with "': ".
      const submodulePath = /^\s*Submodule path '(.+)': /.exec(line)?.[1];
      if (submodulePath !== undefined)
        return setupTracker.stage(threadId, "submodules", { detail: submodulePath });
      if (parseGitCloneProgressLine(line) === null) return Effect.void;
      // Git redraws on every percent; hold the websocket to one update a second.
      return Effect.flatMap(Clock.currentTimeMillis, (now) => {
        if (now - reportedAt < 1000) return Effect.void;
        reportedAt = now;
        return setupTracker.stage(threadId, "submodules", {
          detail: line.trim().replace(/\s+/g, " "),
        });
      });
    },
    onSubmodulesFinished: ({
      ok,
      detail,
    }: {
      readonly ok: boolean;
      readonly detail: string | null;
    }) =>
      setupTracker.stageStatus(
        threadId,
        "submodules",
        ok ? "done" : "warning",
        ok ? undefined : (detail ?? "submodule checkout failed"),
      ),
  };
};

/** The checkout is in place: a submodule step nothing started had no submodules to fetch. */
export const checkedOutTo =
  (worktreePath: string, branch: string) =>
  (snapshot: WorktreeSetupSnapshot): WorktreeSetupSnapshot => ({
    ...snapshot,
    worktreePath,
    branch,
    stages: snapshot.stages.map((stage) =>
      stage.id === "submodules" && stage.status === "pending"
        ? { ...stage, status: "skipped", detail: "none" }
        : stage,
    ),
  });
