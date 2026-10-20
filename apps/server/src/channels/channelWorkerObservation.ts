/**
 * Reads what a channel task's worker thread shows besides its run status: the pull requests it
 * linked, the native requests only a person can answer, and a usage-limit wait. Local workers
 * read their thread directly; remote workers get the same facts from the remote GOAT, so both
 * paths decide holds and "needs you" the same way.
 *
 * @module channelWorkerObservation
 */
import type {
  OrchestrationV2Subagent,
  ChannelTaskApprovalRef,
  ChannelTaskNeedsYou,
  ChannelTaskNeedsYouKind,
  ChannelTaskPullRequest,
  ChannelWorkerObservation,
  OrchestrationV2ProviderThread,
  OrchestrationV2Run,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2ThreadShell,
  ThreadId,
  ThreadPullRequestLink,
} from "@goat/contracts";
import { derivePendingBackgroundWork } from "@goat/shared/orchestrationV2PendingBackgroundWork";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

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

/**
 * Pending person-facing requests, oldest first. With `threadOf`, an approval names its request
 * and thread so GOAT Bot can answer it.
 */
export const needsYouFromRuntimeRequests = <
  T extends Pick<OrchestrationV2RuntimeRequest, "id" | "kind" | "status" | "createdAt">,
>(
  requests: ReadonlyArray<T>,
  threadOf?: (request: T) => ThreadId,
): ReadonlyArray<ChannelTaskNeedsYou> =>
  requests
    .flatMap((request): ReadonlyArray<ChannelTaskNeedsYou> => {
      if (request.status !== "pending") return [];
      const kind = needsYouKindOf(request.kind);
      if (kind === undefined) return [];
      const since = DateTime.formatIso(request.createdAt);
      return kind === "approval" && threadOf !== undefined
        ? [{ kind, since, approval: { requestId: request.id, threadId: threadOf(request) } }]
        : [{ kind, since }];
    })
    .toSorted((left, right) =>
      left.since === right.since
        ? left.kind.localeCompare(right.kind) ||
          (left.approval?.requestId ?? "").localeCompare(right.approval?.requestId ?? "")
        : left.since < right.since
          ? -1
          : 1,
    );

/** Names the machine that holds these approvals. An empty host leaves the refs as they are. */
export const withApprovalHost = (
  needsYou: ReadonlyArray<ChannelTaskNeedsYou>,
  host: string,
): ReadonlyArray<ChannelTaskNeedsYou> =>
  host === ""
    ? needsYou
    : needsYou.map((need) =>
        need.approval === undefined ? need : { ...need, approval: { ...need.approval, host } },
      );

/** Approvals in `next` that `previous` did not list: each gets one card. */
export const newApprovals = (
  previous: ReadonlyArray<ChannelTaskNeedsYou> | undefined,
  next: ReadonlyArray<ChannelTaskNeedsYou>,
): ReadonlyArray<ChannelTaskApprovalRef> => {
  const known = new Set((previous ?? []).flatMap((need) => need.approval?.requestId ?? []));
  return next.flatMap((need) =>
    need.approval === undefined || known.has(need.approval.requestId) ? [] : [need.approval],
  );
};

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

/** Whether a failed thread read means the thread does not exist, rather than a read that failed. */
export const isThreadMissing = (error: unknown): boolean => {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && typeof current === "object" && current !== null; depth += 1) {
    if ((current as { readonly _tag?: string })._tag === "ProjectionStoreThreadNotFoundError") {
      return true;
    }
    current = (current as { readonly cause?: unknown }).cause;
  }
  return false;
};
/** How deep and how many subagent threads a pass reads for requests that need a person. */
export const SUBAGENT_DEPTH = 3;
export const SUBAGENT_THREADS = 20;
const LIVE_SUBAGENT_STATUSES: ReadonlySet<OrchestrationV2Subagent["status"]> = new Set([
  "pending",
  "running",
  "waiting",
]);

/** What one bounded walk of a worker's live subagents found. */
export interface SubagentScan {
  /** Pending requests on subagent threads that live on this machine. */
  readonly requests: ReadonlyArray<OrchestrationV2RuntimeRequest & { readonly threadId: ThreadId }>;
  /** Live subagents whose GOAT is on another machine, in walk order. */
  readonly remote: ReadonlyArray<{ readonly host: string; readonly correlationId: string }>;
  /** Local subagent threads the walk visited, for a waiter to subscribe to. */
  readonly localThreadIds: ReadonlyArray<ThreadId>;
}

/**
 * The live subagents a worker started, and theirs, a few levels down and a bounded number of
 * threads at most, each thread once. A subagent on another machine has no thread here: it is
 * returned in `remote` so the caller can use the report already stored for that dispatch. A
 * cloud subagent, with no thread and no remote dispatch, is not read and does not take a slot.
 * A thread that cannot be read is skipped this pass.
 */
export const scanSubagents = <E, R>(
  subagents: ReadonlyArray<OrchestrationV2Subagent>,
  read: (threadId: NonNullable<OrchestrationV2Subagent["childThreadId"]>) => Effect.Effect<
    {
      readonly runtimeRequests: ReadonlyArray<OrchestrationV2RuntimeRequest>;
      readonly subagents: ReadonlyArray<OrchestrationV2Subagent>;
    },
    E,
    R
  >,
): Effect.Effect<SubagentScan, never, R> =>
  Effect.gen(function* () {
    const requests: Array<OrchestrationV2RuntimeRequest & { readonly threadId: ThreadId }> = [];
    const remote: Array<{ readonly host: string; readonly correlationId: string }> = [];
    const localThreadIds: Array<ThreadId> = [];
    const visited = new Set<string>();
    let level = subagents;
    for (let depth = 0; depth < SUBAGENT_DEPTH && level.length > 0; depth += 1) {
      const next: Array<OrchestrationV2Subagent> = [];
      for (const subagent of level) {
        if (
          subagent.promotedAt !== undefined ||
          !LIVE_SUBAGENT_STATUSES.has(subagent.status) ||
          visited.size >= SUBAGENT_THREADS
        ) {
          continue;
        }
        const childThreadId = subagent.childThreadId;
        if (childThreadId === null) {
          const elsewhere = subagent.remote;
          const correlationId = elsewhere?.correlationId;
          if (
            elsewhere !== undefined &&
            typeof correlationId === "string" &&
            correlationId !== "" &&
            !visited.has(correlationId)
          ) {
            visited.add(correlationId);
            remote.push({ host: elsewhere.host, correlationId });
          }
          continue;
        }
        if (visited.has(childThreadId)) continue;
        visited.add(childThreadId);
        localThreadIds.push(childThreadId);
        const child = yield* read(childThreadId).pipe(Effect.option);
        if (child._tag === "None") continue;
        requests.push(
          ...child.value.runtimeRequests.map((request) => ({
            ...request,
            threadId: childThreadId,
          })),
        );
        next.push(...child.value.subagents);
      }
      level = next;
    }
    return { requests, remote, localThreadIds };
  });

/** Pending requests of the live local subagents a worker started. Remote children are not read. */
export const subagentRequests = <E, R>(
  subagents: ReadonlyArray<OrchestrationV2Subagent>,
  read: (threadId: NonNullable<OrchestrationV2Subagent["childThreadId"]>) => Effect.Effect<
    {
      readonly runtimeRequests: ReadonlyArray<OrchestrationV2RuntimeRequest>;
      readonly subagents: ReadonlyArray<OrchestrationV2Subagent>;
    },
    E,
    R
  >,
): Effect.Effect<
  ReadonlyArray<OrchestrationV2RuntimeRequest & { readonly threadId: ThreadId }>,
  never,
  R
> => scanSubagents(subagents, read).pipe(Effect.map((scan) => scan.requests));
