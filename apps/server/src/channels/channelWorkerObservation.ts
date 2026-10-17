/**
 * Reads what a channel task's worker thread shows besides its run status: the pull requests it
 * linked, the native requests only a person can answer, and a usage-limit wait. Local workers
 * read their thread directly; remote workers get the same facts from the remote GOAT, so both
 * paths decide holds and "needs you" the same way.
 *
 * @module channelWorkerObservation
 */
import type {
  ChannelTaskNeedsYou,
  ChannelTaskNeedsYouKind,
  ChannelTaskPullRequest,
  ChannelWorkerObservation,
  OrchestrationV2ProviderThread,
  OrchestrationV2Run,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2ThreadShell,
  ThreadPullRequestLink,
} from "@goat/contracts";
import { derivePendingBackgroundWork } from "@goat/shared/orchestrationV2PendingBackgroundWork";
import * as DateTime from "effect/DateTime";

/** Which person-facing request a native runtime request is; tool calls the client answers are none. */
export const needsYouKindOf = (
  kind: OrchestrationV2RuntimeRequest["kind"],
): ChannelTaskNeedsYouKind | undefined => {
  switch (kind) {
    case "user_input":
    case "mcp-elicitation":
      return "question";
    case "auth_refresh":
      return "sign_in";
    case "command":
    case "file-read":
    case "file-change":
    case "permission":
      return "approval";
    case "dynamic_tool_call":
      return undefined;
  }
};

export const needsYouFromRuntimeRequests = (
  requests: ReadonlyArray<Pick<OrchestrationV2RuntimeRequest, "kind" | "status" | "createdAt">>,
): ReadonlyArray<ChannelTaskNeedsYou> =>
  requests
    .flatMap((request) => {
      if (request.status !== "pending") return [];
      const kind = needsYouKindOf(request.kind);
      return kind === undefined ? [] : [{ kind, since: DateTime.formatIso(request.createdAt) }];
    })
    .toSorted((left, right) =>
      left.since === right.since
        ? left.kind.localeCompare(right.kind)
        : left.since < right.since
          ? -1
          : 1,
    );

export const pullRequestsFromLinks = (
  links: ReadonlyArray<ThreadPullRequestLink> | undefined,
): ReadonlyArray<ChannelTaskPullRequest> =>
  (links ?? [])
    .filter((link) => link.source !== "stack-dismissed")
    .map((link) => ({
      repository: link.repository,
      number: link.number,
      url: link.url,
      ...(link.snapshot === null ? {} : { state: link.snapshot.state }),
      watching: link.watch !== undefined,
    }))
    .toSorted((left, right) =>
      left.repository === right.repository
        ? left.number - right.number
        : left.repository.localeCompare(right.repository),
    );

/**
 * What keeps a completed run from being the worker's last word: provider background work still
 * running, and pull request watches that wake the worker when checks, reviews or conflicts change.
 * Commands the worker left running in its turn items (dev servers, watchers) never hold.
 */
export const completionHoldCount = (input: {
  readonly current: Pick<OrchestrationV2Run, "id" | "ordinal" | "status">;
  readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "ordinal" | "status">>;
  readonly providerThreads: ReadonlyArray<
    Pick<OrchestrationV2ProviderThread, "id" | "pendingBackgroundTasks">
  >;
  readonly pullRequests: ReadonlyArray<ThreadPullRequestLink> | undefined;
}): number =>
  derivePendingBackgroundWork({
    latestRun: input.current,
    runs: input.runs,
    providerThreads: input.providerThreads,
    turnItems: [],
    pullRequests: input.pullRequests,
  }).length;

/** How a worker run that stopped on a usage limit continues. */
export interface UsageLimitWait {
  /** Shown while the worker waits to be resumed after the reset. */
  readonly resetAt?: string;
  /** Set when nothing resumes the worker without a person. */
  readonly needsYou?: ChannelTaskNeedsYou;
  /**
   * Set when the reset is ahead and the thread has no recovery choice for this run yet. Arming
   * automatic resume (where the caller can) turns the wait into `{ resetAt }`; otherwise it needs
   * a person.
   */
  readonly arm?: { readonly resetAt: string; readonly resetMs: number };
}

/**
 * Whether `run`, the worker thread's latest, stopped on a usage limit, and how it continues: with
 * automatic resume chosen it waits for the reset; with none chosen yet and a reset ahead it can be
 * armed; a thread set not to resume, or a limit with no usable reset, needs a person.
 */
export const usageLimitWait = (
  shell: Pick<
    OrchestrationV2ThreadShell,
    "lastErrorClass" | "latestRunId" | "usageLimitResetAt" | "limitRecovery"
  > | null,
  run: Pick<OrchestrationV2Run, "id" | "completedAt">,
  now: DateTime.Utc,
): UsageLimitWait | undefined => {
  if (shell === null || shell.lastErrorClass !== "usage_limit" || shell.latestRunId !== run.id) {
    return undefined;
  }
  const resetAt = shell.usageLimitResetAt ?? undefined;
  const resetMs = resetAt === undefined ? Number.NaN : Date.parse(resetAt);
  const future = Number.isFinite(resetMs) && resetMs > DateTime.toEpochMillis(now);
  const recovery = shell.limitRecovery ?? undefined;
  const chosen =
    recovery !== undefined && recovery.runId === run.id && recovery.resetAt === resetAt;
  if (resetAt !== undefined && chosen && recovery.autoResume) return { resetAt };
  const needsYou: ChannelTaskNeedsYou = {
    kind: "usage_limit",
    since: DateTime.formatIso(run.completedAt ?? now),
  };
  if (resetAt !== undefined && future && !chosen)
    return { resetAt, needsYou, arm: { resetAt, resetMs } };
  return { ...(future && resetAt !== undefined ? { resetAt } : {}), needsYou };
};

/** Whether an observation says the worker is paused on a usage limit rather than finished. */
export const observesUsageLimit = (observed: ChannelWorkerObservation | undefined): boolean =>
  observed !== undefined &&
  (observed.usageLimitResetAt !== undefined ||
    observed.needsYou.some((item) => item.kind === "usage_limit"));

export const observeWorker = (input: {
  readonly pullRequests: ReadonlyArray<ChannelTaskPullRequest>;
  readonly needsYou: ReadonlyArray<ChannelTaskNeedsYou>;
  readonly usageLimitResetAt?: string | undefined;
}): ChannelWorkerObservation => ({
  pullRequests: [...input.pullRequests],
  needsYou: [...input.needsYou],
  ...(input.usageLimitResetAt === undefined ? {} : { usageLimitResetAt: input.usageLimitResetAt }),
});
