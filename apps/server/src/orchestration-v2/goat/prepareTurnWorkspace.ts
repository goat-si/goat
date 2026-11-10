import {
  describeThreadWorkspaceRestore,
  type OrchestrationV2TurnItem,
  type ProjectId,
  type ProviderThreadId,
  type ThreadId,
  type ThreadWorkspaceRestoreResult,
} from "@goat/contracts";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";

import * as ProjectService from "../../project/ProjectService.ts";
import { tryWithWorkspaceLease } from "../../workspace/workspaceLease.ts";
import { makeIsManagedWorktreePath } from "../../worktreesDirectory.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import { makeRestorePending, makeRestoreThreadWorkspace } from "./restoreThreadWorkspace.ts";

type Restored = Pick<ThreadWorkspaceRestoreResult, "restoredFrom" | "setupScript">;

/**
 * Before a local turn starts in a worktree: confirm the thread still uses it and, when the folder
 * is gone or its restore never finished, bring it back. Busy sends the start to the outbox retry.
 */
export const makePrepareTurnWorkspace = Effect.gen(function* () {
  const path = yield* Path.Path;
  const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectService.ProjectService;
  const restorePending = yield* makeRestorePending;
  const restoreMissing = yield* makeRestoreThreadWorkspace;
  const isManagedWorktreePath = yield* makeIsManagedWorktreePath;
  return Effect.fn("ProviderTurnStart.prepareWorkspace")(function* (thread: {
    readonly id: ThreadId;
    readonly projectId: ProjectId;
    readonly worktreePath: string;
    readonly branch: string | null;
  }) {
    const { worktreePath, branch } = thread;
    // Removal may hold this lease for minutes. Return to the outbox's
    // retry schedule instead of occupying an effect-worker slot waiting.
    const prepared = yield* tryWithWorkspaceLease(
      path.resolve(worktreePath),
      Effect.gen(function* () {
        // A rebinding that committed after this start loaded the thread sends it to retry.
        const bound = yield* projectionStore.getThreadShell(thread.id).pipe(Effect.option);
        if (Option.getOrNull(bound)?.worktreePath !== worktreePath) return "rebound" as const;
        if (branch === null) return undefined;
        const ready = yield* restorePending.ready(worktreePath);
        if (ready || !(yield* isManagedWorktreePath(worktreePath))) return undefined;
        const project = yield* projects.getById(thread.projectId).pipe(
          Effect.map(Option.getOrUndefined),
          Effect.orElseSucceed(() => undefined),
        );
        if (project === undefined) return undefined;
        yield* Effect.logWarning("provider turn start recreating missing worktree", {
          threadId: thread.id,
          worktreePath,
          branch,
        });
        return yield* restoreMissing({
          threadId: thread.id,
          cwd: project.workspaceRoot,
          worktreePath,
          branch,
        });
      }).pipe(Effect.result),
    );
    if (Option.isNone(prepared) || Result.getOrUndefined(prepared.value) === "rebound")
      return { _tag: "Busy" } as const;
    if (prepared.value._tag === "Failure")
      return { _tag: "Failed", error: prepared.value.failure } as const;
    const restored: Restored | undefined =
      prepared.value.success === "rebound" ? undefined : prepared.value.success;
    return { _tag: "Ready", restored } as const;
  });
});

/** The thread notice a turn leaves after it brought the worktree back, saying what did not come back. */
export function workspaceRestoredItem(input: {
  readonly id: OrchestrationV2TurnItem["id"];
  readonly threadId: ThreadId;
  readonly runId: OrchestrationV2TurnItem["runId"];
  readonly nodeId: OrchestrationV2TurnItem["nodeId"];
  readonly providerThreadId: ProviderThreadId | null;
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly now: DateTime.Utc;
  readonly branch: string;
  readonly restored: Restored;
}): OrchestrationV2TurnItem {
  const { summary, lost } = describeThreadWorkspaceRestore({
    ...input.restored,
    branch: input.branch,
  });
  return {
    id: input.id,
    threadId: input.threadId,
    runId: input.runId,
    nodeId: input.nodeId,
    providerThreadId: input.providerThreadId,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal:
      Math.max(
        0,
        ...input.turnItems.filter((item) => item.runId === input.runId).map((item) => item.ordinal),
      ) + 1,
    status: "completed",
    title: null,
    startedAt: input.now,
    completedAt: input.now,
    updatedAt: input.now,
    type: "notification",
    source: { kind: "system" },
    outcome: "updated",
    summary,
    ...(lost === null ? {} : { detail: lost }),
  };
}
