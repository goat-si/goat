import {
  isSideChatThread,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2TurnItem,
  type OrchestratorMcpFailure,
  type OrchestratorMcpThreadDetail,
  type OrchestratorMcpThreadFoldState,
  type OrchestratorMcpThreadListInput,
  type OrchestratorMcpThreadListItem,
  type OrchestratorMcpThreadPullRequest,
  type OrchestratorMcpThreadSummaryDigest,
  type ThreadId,
} from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { isSnoozed } from "../orchestration-v2/ThreadSettlementService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import {
  normalizeThreadPullRequestKey,
  visibleThreadPullRequests,
} from "../sourceControl/threadPullRequests.ts";
import { threadLinkFor, type McpInvocationScope } from "./McpInvocationContext.ts";
import { launchGraph, launcherThreadIdOf } from "./threadLaunchFold.ts";
import { excerpt, statusFromShell, threadOrganization } from "./threadStatus.ts";

type LineageInput = Pick<
  OrchestratorMcpThreadListInput,
  "launchedBy" | "parentThreadId" | "childrenOf"
>;
/** A lineage filter with "self" replaced by the calling thread. */
export type LineageFilter = { readonly [K in keyof LineageInput]?: ThreadId };

export const SELF_NEEDS_THREAD = '"self" names the calling GOAT thread; pass a threadId instead.';

export const lineageInput = (input: LineageInput): LineageInput => ({
  launchedBy: input.launchedBy,
  parentThreadId: input.parentThreadId,
  childrenOf: input.childrenOf,
});

export const hasLineageFilter = (input: LineageInput) =>
  input.launchedBy !== undefined ||
  input.parentThreadId !== undefined ||
  input.childrenOf !== undefined;

/** Null when "self" names a caller that is not a GOAT thread. */
export function resolveLineageFilter(
  input: LineageInput,
  caller: ThreadId | undefined,
): LineageFilter | null {
  const resolve = (value: ThreadId | "self" | undefined) =>
    value === "self" ? (caller ?? null) : value;
  const launchedBy = resolve(input.launchedBy);
  const parentThreadId = resolve(input.parentThreadId);
  const childrenOf = resolve(input.childrenOf);
  if (launchedBy === null || parentThreadId === null || childrenOf === null) return null;
  return {
    ...(launchedBy === undefined ? {} : { launchedBy }),
    ...(parentThreadId === undefined ? {} : { parentThreadId }),
    ...(childrenOf === undefined ? {} : { childrenOf }),
  };
}

export function matchesLineage(
  shell: Parameters<typeof launcherThreadIdOf>[0],
  filter: LineageFilter,
): boolean {
  const launcher = launcherThreadIdOf(shell);
  const parent = shell.lineage.parentThreadId;
  // A goat_task_create child on another host has no parent there, only its launch record.
  const delegatedBy =
    shell.launchedBy?.kind === "launch" && shell.launchedBy.via === "delegate_task"
      ? shell.launchedBy.threadId
      : null;
  return (
    (filter.launchedBy === undefined || launcher === filter.launchedBy) &&
    (filter.parentThreadId === undefined || parent === filter.parentThreadId) &&
    (filter.childrenOf === undefined ||
      launcher === filter.childrenOf ||
      parent === filter.childrenOf ||
      delegatedBy === filter.childrenOf)
  );
}

/** What goat_thread_list shows without includeSubagents:false, like the user's thread list. */
export const listedByDefault = (shell: OrchestrationV2ThreadShell) =>
  shell.lineage.relationshipToParent !== "subagent" && !isSideChatThread(shell);

const LIVE_RUN_STATUSES: ReadonlySet<string> = new Set([
  "preparing",
  "starting",
  "running",
  "waiting",
]);

/**
 * Open requests: pending runtime requests and the secret or handoff cards waiting beside them,
 * read as the thread shell reads them (a secret card counts while its run is live).
 */
const pendingRequestCount = (
  records: Pick<OrchestrationV2ThreadProjection, "runtimeRequests" | "turnItems" | "runs">,
) => {
  const liveRuns = new Set(
    records.runs.flatMap((run) => (LIVE_RUN_STATUSES.has(run.status) ? [run.id] : [])),
  );
  return new Set<string>([
    ...records.runtimeRequests.flatMap((request) =>
      request.status === "pending" ? [request.id] : [],
    ),
    ...records.turnItems.flatMap((item) =>
      item.status === "waiting" &&
      (item.type === "human_handoff" ||
        (item.type === "secret_request" && item.runId !== null && liveRuns.has(item.runId)))
        ? [item.id]
        : [],
    ),
  ]).size;
};
const CARD_TYPES = ["secret_request", "human_handoff"] as const;

/** The caller's own delegated tasks whose automatic completion delivery is still open. */
export const unacknowledgedTasks = (
  parent: Pick<OrchestrationV2ThreadProjection, "thread" | "subagents">,
  matches: (task: OrchestrationV2Subagent) => boolean,
) =>
  parent.subagents.filter(
    (task) =>
      task.origin === "app_owned" &&
      task.threadId === parent.thread.id &&
      task.completionDelivery?.state !== "acknowledged" &&
      task.completionDelivery?.state !== "disposed" &&
      matches(task),
  );

/** view "summary": the thread's state in a few hundred bytes instead of its timeline. */
function summaryDigest(input: {
  readonly shell: OrchestrationV2ThreadShell;
  readonly target: Pick<OrchestrationV2ThreadProjection, "runs" | "runtimeRequests">;
  readonly foldState: OrchestratorMcpThreadFoldState;
  readonly assistantItems: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly cards: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly totalItems: number;
}): OrchestratorMcpThreadSummaryDigest {
  const latest = input.assistantItems
    .flatMap((item) => (item.type === "assistant_message" && item.text.trim() !== "" ? [item] : []))
    .toSorted((left, right) => left.ordinal - right.ordinal)
    .at(-1);
  return {
    phase: statusFromShell(input.shell, input.target.runs, []).phase,
    foldState: input.foldState,
    lastAnsweredLine: input.shell.latestAnswerExcerpt ?? null,
    lastAssistantExcerpt: latest === undefined ? null : excerpt(latest.text),
    pendingRequests: pendingRequestCount({ ...input.target, turnItems: input.cards }),
    totalItems: input.totalItems,
    totalRuns: input.target.runs.length,
  };
}

export function threadSettlement(
  thread: Pick<OrchestrationV2ThreadShell, "settledOverride" | "settledAt">,
): Pick<OrchestratorMcpThreadListItem, "settled" | "settledAt"> {
  const settled = thread.settledOverride === "settled";
  return {
    settled,
    settledAt: settled && thread.settledAt !== null ? DateTime.formatIso(thread.settledAt) : null,
  };
}

function threadSnooze(
  thread: Parameters<typeof isSnoozed>[0],
  nowMs: number,
): Pick<OrchestratorMcpThreadListItem, "snoozed" | "snoozedUntil"> {
  const snoozed = isSnoozed(thread, nowMs);
  return {
    snoozed,
    snoozedUntil:
      snoozed && thread.snoozedUntil != null ? DateTime.formatIso(thread.snoozedUntil) : null,
  };
}

function threadPullRequests(
  links: OrchestrationV2ThreadShell["pullRequests"],
): OrchestratorMcpThreadPullRequest[] {
  return visibleThreadPullRequests(links ?? []).map((link) => ({
    host: normalizeThreadPullRequestKey(link).host,
    repository: link.repository,
    number: link.number,
    url: link.url,
    source: link.source,
    state: link.snapshot?.state ?? null,
  }));
}

type LinkScope = Pick<McpInvocationScope, "environmentId" | "client">;

export function listItemFromShell(
  scope: LinkScope,
  shell: OrchestrationV2ThreadShell,
  nowMs: number,
  lineage: Pick<OrchestratorMcpThreadListItem, "foldState" | "pendingRequestCount">,
): OrchestratorMcpThreadListItem {
  return {
    threadId: shell.id,
    projectId: shell.projectId,
    title: shell.title,
    link: threadLinkFor(scope, shell.id, shell.title),
    createdBy: shell.createdBy,
    creationSource: shell.creationSource,
    status: shell.activityRunStatus ?? shell.status,
    latestRunId: shell.latestRunId,
    providerInstanceId: shell.modelSelection.instanceId,
    model: shell.modelSelection.model,
    runtimeMode: shell.runtimeMode,
    interactionMode: shell.interactionMode,
    linkedPullRequest: shell.linkedPullRequest ?? null,
    pullRequests: threadPullRequests(shell.pullRequests),
    ...threadSettlement(shell),
    ...threadSnooze(shell, nowMs),
    parentThreadId: shell.lineage.parentThreadId,
    relationshipToParent: shell.lineage.relationshipToParent,
    itemCount: shell.visibleItemCount,
    launchedByThreadId: launcherThreadIdOf(shell),
    ...lineage,
    lastAnsweredLine: shell.latestAnswerExcerpt ?? null,
    createdAt: DateTime.formatIso(shell.createdAt),
    updatedAt: DateTime.formatIso(shell.updatedAt),
  };
}

export function threadDetail(
  scope: LinkScope,
  projection: Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "runtimeRequests">,
  itemCount: number,
  shell: OrchestrationV2ThreadShell,
  nowMs: number,
): OrchestratorMcpThreadDetail {
  const latest = ThreadManagementService.latestRun(projection);
  const active = ThreadManagementService.latestActiveRun(projection);
  return {
    threadId: projection.thread.id,
    projectId: projection.thread.projectId,
    title: projection.thread.title,
    link: threadLinkFor(scope, projection.thread.id, projection.thread.title),
    createdBy: projection.thread.createdBy,
    creationSource: projection.thread.creationSource,
    status: active?.status ?? latest?.status ?? "idle",
    latestRunId: latest?.id ?? null,
    activeRunId: active?.id ?? null,
    providerInstanceId: projection.thread.modelSelection.instanceId,
    model: projection.thread.modelSelection.model,
    runtimeMode: projection.thread.runtimeMode,
    interactionMode: projection.thread.interactionMode,
    linkedPullRequest: projection.thread.linkedPullRequest ?? null,
    pullRequests: threadPullRequests(projection.thread.pullRequests),
    titleRegeneration:
      projection.thread.titleRegeneration === undefined ||
      projection.thread.titleRegeneration === null
        ? null
        : {
            requestId: projection.thread.titleRegeneration.requestId,
            startedAt: DateTime.formatIso(projection.thread.titleRegeneration.startedAt),
          },
    branch: projection.thread.branch,
    worktreePath: projection.thread.worktreePath,
    parentThreadId: projection.thread.lineage.parentThreadId,
    relationshipToParent: projection.thread.lineage.relationshipToParent,
    runCount: projection.runs.length,
    itemCount,
    pendingRequestCount: projection.runtimeRequests.filter(
      (request) => request.status === "pending",
    ).length,
    archived: projection.thread.archivedAt !== null,
    ...threadSettlement(projection.thread),
    ...threadSnooze(shell, nowMs),
    ...threadOrganization(projection.thread, latest, shell),
    createdAt: DateTime.formatIso(projection.thread.createdAt),
    updatedAt: DateTime.formatIso(projection.thread.updatedAt),
  };
}

/** The reads goat_thread_list and view "summary" add: request counts, shells by id, the digest. */
export const makeLineageReads = (
  threads: ThreadManagementService.ThreadManagementService["Service"],
  onFailure: (error: unknown) => OrchestratorMcpFailure,
) => {
  const pendingRequestCountOf = (shell: OrchestrationV2ThreadShell) =>
    shell.pendingRuntimeRequest === null
      ? Effect.succeed(0)
      : threads
          .getThreadRecords(shell.id, ["runtimeRequests", "turnItems", "runs"], {
            turnItemTypes: [...CARD_TYPES],
          })
          .pipe(Effect.map(pendingRequestCount), Effect.mapError(onFailure));
  /** Active shells by id, newest first like listProjectThreads. */
  const readShells = (threadIds: ReadonlyArray<ThreadId>) =>
    threadIds.length === 0
      ? Effect.succeed([])
      : threads.getShellSnapshot({ location: "active", threadIds }).pipe(
          Effect.map(({ threads: shells }) =>
            shells
              .filter((shell) => threadIds.includes(shell.id))
              .toSorted(
                (left, right) =>
                  DateTime.toEpochMillis(right.updatedAt) -
                    DateTime.toEpochMillis(left.updatedAt) || right.id.localeCompare(left.id),
              ),
          ),
          Effect.mapError(onFailure),
        );
  const readSummary = Effect.fn("OrchestratorMcpService.readSummary")(function* (
    shell: OrchestrationV2ThreadShell,
    target: Pick<OrchestrationV2ThreadProjection, "runs" | "runtimeRequests">,
    totalItems: number,
  ) {
    const runIds = [...new Set([shell.activeRunId, shell.latestRunId].filter((id) => id !== null))];
    const [edges, records, cards] = yield* Effect.all([
      threads.listLaunchEdges(),
      threads.getThreadRecords(shell.id, ["turnItems"], {
        turnItemRunIds: runIds,
        turnItemTypes: ["assistant_message"],
      }),
      threads.getThreadRecords(shell.id, ["turnItems"], { turnItemTypes: [...CARD_TYPES] }),
    ]).pipe(Effect.mapError(onFailure));
    const graph = launchGraph(edges);
    const folded = [...graph.reach([shell.id])].filter((id) => id !== shell.id);
    const shells = new Map((yield* readShells(folded)).map((thread) => [thread.id, thread]));
    shells.set(shell.id, shell);
    return summaryDigest({
      shell,
      target,
      foldState: graph.foldStates(shells, yield* Clock.currentTimeMillis)(shell.id),
      assistantItems: records.turnItems,
      cards: cards.turnItems,
      totalItems,
    });
  });
  return { pendingRequestCountOf, readShells, readSummary, launchGraph };
};
