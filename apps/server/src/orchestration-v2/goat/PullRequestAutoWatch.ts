import {
  isProviderNativeSubagentThread,
  type OrchestrationV2AppThread,
  type OrchestrationV2ServerCommand,
  type RunId,
  type ServerSettings,
  type ServerSettingsError,
  type ThreadId,
  type ThreadPullRequestWatch,
} from "@goat/contracts";
import { latestExecutedRun } from "@goat/shared/orchestrationV2ThreadError";
import { resolveProjectSettings } from "@goat/shared/projectSettings";
import * as Effect from "effect/Effect";

import type { OrchestratorDispatchError, OrchestratorV2Error } from "../Orchestrator.ts";
import type { ProjectionStoreV2Shape } from "../ProjectionStore.ts";
import { keptAfterPass } from "../pullRequestWatch.ts";

/** A watch starting now. An automatic one wakes the agent but does not keep the thread working. */
export function newPullRequestWatch(
  startedAt: string,
  automatic: boolean,
  ended: ThreadPullRequestWatch | undefined,
): ThreadPullRequestWatch {
  return {
    startedAt,
    headSha: null,
    failedChecks: [],
    passed: false,
    passedChecks: [],
    conflicting: false,
    // Watching again must not repeat check or conflict news the last watch told.
    ...(ended && {
      headSha: ended.headSha,
      failedChecks: ended.failedChecks,
      passed: ended.passed,
      passedChecks: ended.passedChecks,
      conflicting: ended.conflicting,
    }),
    ...(ended?.owedChecks !== undefined && { owedChecks: ended.owedChecks }),
    ...(ended?.awaitingApproval !== undefined && { awaitingApproval: ended.awaitingApproval }),
    ...(ended?.approvalAnnounced !== undefined && { approvalAnnounced: ended.approvalAnnounced }),
    ...(ended?.checksAwaitedSince !== undefined && {
      checksAwaitedSince: ended.checksAwaitedSince,
    }),
    // A finished-checks answer may be an older head's; a fresh read decides.
    ...(ended?.checksPending === true && { checksPending: true }),
    // A first watch records what is already there; watching again resumes the ended one's state.
    ...(ended === undefined
      ? { awaitingBaseline: "all" as const }
      : ended.awaitingBaseline !== undefined && { awaitingBaseline: ended.awaitingBaseline }),
    remarksThrough: startedAt,
    remarkIds: [],
    wakes: 0,
    ...(automatic ? { automatic: true } : {}),
  };
}

/** The same watch, now asked for: from here on it keeps the thread working while checks run. */
export function explicitPullRequestWatch(watch: ThreadPullRequestWatch): ThreadPullRequestWatch {
  const { automatic: _automatic, ...rest } = watch;
  return rest;
}

/** A watch that no longer knows whether its checks are running, as after a push. */
export function withoutChecksAnswer(watch: ThreadPullRequestWatch): ThreadPullRequestWatch {
  const { checksPending: _checksPending, ...rest } = watch;
  return rest;
}

/**
 * Recorded progress on the current watch, which keeps its own automatic flag. The reader sends
 * only what this pass kept as context; it is merged here, under the thread lock, so fragments a
 * starting turn told and cleared while the host was read are not written back. Fragments the
 * new state contradicts (a cleared conflict, checks of a replaced head) are dropped first.
 */
export function syncedPullRequestWatch(
  current: ThreadPullRequestWatch,
  observed: ThreadPullRequestWatch,
  checksPendingBefore?: boolean,
): ThreadPullRequestWatch {
  const { heldContext: kept, ...read } = explicitPullRequestWatch(observed);
  // A push cleared the answer while this read was in flight, so its answer is the old head's.
  const progress =
    checksPendingBefore !== undefined && current.checksPending === undefined
      ? withoutChecksAnswer(read)
      : read;
  const heldContext = keptAfterPass(current.heldContext, kept, {
    ...progress,
    headMoved: progress.headSha !== current.headSha,
  });
  return {
    ...progress,
    ...(heldContext.length === 0 ? {} : { heldContext }),
    ...(current.automatic === true ? { automatic: true } : {}),
  };
}

export interface PullRequestAutoWatchDeps {
  readonly serverSettings: {
    readonly getSettings: Effect.Effect<ServerSettings, ServerSettingsError>;
  };
  readonly projectionStore: ProjectionStoreV2Shape;
  readonly stopReachedRun: (
    command: OrchestrationV2ServerCommand,
    threadId: ThreadId,
    runId: RunId,
  ) => Effect.Effect<boolean, OrchestratorV2Error>;
  readonly mapDispatchError: (
    command: OrchestrationV2ServerCommand,
  ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, OrchestratorDispatchError, R>;
}

export const makePullRequestAutoWatch = (deps: PullRequestAutoWatchDeps) => {
  const { serverSettings, projectionStore, stopReachedRun, mapDispatchError } = deps;

  /**
   * A pull request the thread created, or its agent linked, is watched without a
   * watch_pull_request call when the project's policy allows, under the limits an agent's
   * watch has. A settings read that fails only skips the watch; the link still lands.
   * It runs inside the thread mutation span and has none of its own.
   */
  const shouldAutoWatchPullRequest = Effect.fnUntraced(function* (
    command: OrchestrationV2ServerCommand,
    thread: OrchestrationV2AppThread,
  ) {
    let autoWatch = false;
    if (
      command.type === "thread.pull-request.link" &&
      (command.source === "created" || command.source === "agent") &&
      thread.archivedAt === null &&
      thread.settledOverride !== "settled" &&
      thread.settledAt === null &&
      !isProviderNativeSubagentThread(thread) &&
      thread.lineage.relationshipToParent !== "subagent"
    ) {
      autoWatch = yield* serverSettings.getSettings.pipe(
        Effect.map(
          (settings) =>
            resolveProjectSettings(settings, thread.projectId).settings.pullRequestWatchPolicy
              .autoWatch,
        ),
        Effect.orElseSucceed(() => false),
      );
      if (autoWatch && command.source === "agent") {
        const { runs } = yield* projectionStore
          .getThreadRecords(command.threadId, ["runs"])
          .pipe(mapDispatchError(command));
        const latest = latestExecutedRun(runs);
        if (latest !== null && (yield* stopReachedRun(command, command.threadId, latest.id))) {
          autoWatch = false;
        }
      }
    }
    return autoWatch;
  });

  return { shouldAutoWatchPullRequest };
};
