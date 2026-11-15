import type { OrchestrationV2ThreadProjection, ServerActivityBlocker } from "@goat/contracts";
import * as DateTime from "effect/DateTime";

import { latestIdleCompactionRun } from "../IdleCompaction.ts";
import type {
  ProjectionRecordField,
  ProjectionRecordFilter,
  ProjectionRecords,
} from "../ProjectionStore.ts";

// GOAT's in-memory projection store reads (ProjectionStore.layerMemory).

type ProjectionNode = OrchestrationV2ThreadProjection["nodes"][number];
type ProjectionRun = OrchestrationV2ThreadProjection["runs"][number];
const settledLeafNodeKinds: ReadonlySet<ProjectionNode["kind"]> = new Set([
  "tool_call",
  "assistant_message",
  "reasoning",
]);
const settledNodeStatuses: ReadonlySet<ProjectionNode["status"]> = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);
const activeRunStatuses: ReadonlySet<ProjectionRun["status"]> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

// In-memory twin of the omitSettledLeafNodes SQL clause in readCanonicalProjection.
export const isSettledLeafNode = (node: ProjectionNode, runs: ReadonlyArray<ProjectionRun>) =>
  settledLeafNodeKinds.has(node.kind) &&
  settledNodeStatuses.has(node.status) &&
  node.runId !== null &&
  !runs.some((run) => run.id === node.runId && activeRunStatuses.has(run.status));

/** The in-memory store's getThreadRecords: `projection`'s records narrowed by `filter`. */
export const selectThreadRecords = <K extends ProjectionRecordField>(
  projection: OrchestrationV2ThreadProjection,
  fields: ReadonlyArray<K>,
  filter: ProjectionRecordFilter | undefined,
) => {
  const latestRun = latestIdleCompactionRun(projection.runs);
  const matchingTurns = projection.providerTurns.filter(
    (row) =>
      (filter?.providerTurnAttemptIds === undefined ||
        (row.runAttemptId !== null && filter.providerTurnAttemptIds.includes(row.runAttemptId))) &&
      (filter?.providerTurnThreadIds === undefined ||
        filter.providerTurnThreadIds.includes(row.providerThreadId)) &&
      (filter?.latestProviderTurnUsageOnly !== true || row.tokenUsage !== undefined) &&
      (filter?.ancestryRunIds === undefined ||
        projection.attempts.some(
          (attempt) =>
            attempt.id === row.runAttemptId && filter.ancestryRunIds?.includes(attempt.runId),
        )),
  );
  const selected = {
    ...projection,
    providerThreads: projection.providerThreads.filter(
      (row) => filter?.providerThreadIds === undefined || filter.providerThreadIds.includes(row.id),
    ),
    providerTurns:
      filter?.latestProviderTurnUsageOnly === true
        ? matchingTurns
            .toSorted(
              (a, b) =>
                (Date.parse(b.tokenUsage?.updatedAt ?? "") || 0) -
                  (Date.parse(a.tokenUsage?.updatedAt ?? "") || 0) ||
                a.providerThreadId.localeCompare(b.providerThreadId) ||
                a.ordinal - b.ordinal,
            )
            .slice(0, 1)
        : matchingTurns,
    runtimeRequests: projection.runtimeRequests.filter(
      (row) =>
        (filter?.runtimeRequestIds === undefined || filter.runtimeRequestIds.includes(row.id)) &&
        (filter?.runtimeRequestStatuses === undefined ||
          filter.runtimeRequestStatuses.includes(row.status)),
    ),
    messages: projection.messages.filter(
      (row) =>
        (filter?.messageRunIds === undefined ||
          (row.runId !== null && filter.messageRunIds.includes(row.runId))) &&
        (filter?.messageIds === undefined || filter.messageIds.includes(row.id)) &&
        (filter?.messageRoles === undefined || filter.messageRoles.includes(row.role)),
    ),
    runs: projection.runs.filter(
      (row) =>
        (filter?.runIds === undefined || filter.runIds.includes(row.id)) &&
        (filter?.runStatuses === undefined ||
          filter.runStatuses.includes(row.status) ||
          (filter.includeLatestRun === true && row.id === latestRun?.id)),
    ),
    attempts: projection.attempts.filter(
      (row) => filter?.ancestryRunIds === undefined || filter.ancestryRunIds.includes(row.runId),
    ),
    contextTransfers: projection.contextTransfers.filter(
      (row) =>
        filter?.contextTransferStatuses === undefined ||
        filter.contextTransferStatuses.includes(row.status),
    ),
    turnItems: projection.turnItems.filter(
      (row) =>
        (filter?.turnItemRequestIds === undefined ||
          ((row.type === "approval_request" || row.type === "user_input_request") &&
            filter.turnItemRequestIds.includes(row.requestId))) &&
        (filter?.turnItemRunIds === undefined || filter.turnItemRunIds.includes(row.runId)) &&
        (filter?.turnItemTypes === undefined || filter.turnItemTypes.includes(row.type)) &&
        (filter?.turnItemStatuses === undefined || filter.turnItemStatuses.includes(row.status)) &&
        (filter?.turnItemNodeIds === undefined ||
          (row.nodeId !== null && filter.turnItemNodeIds.includes(row.nodeId))) &&
        (filter?.turnItemRunId === undefined || filter.turnItemRunId === row.runId),
    ),
    nodes: projection.nodes.filter(
      (node) =>
        (filter?.nodeIds === undefined || filter.nodeIds.includes(node.id)) &&
        (filter?.omitSettledLeafNodes !== true || !isSettledLeafNode(node, projection.runs)),
    ),
    subagents: projection.subagents.filter((task) => {
      if (filter?.subagentIds !== undefined && !filter.subagentIds.includes(task.id)) return false;
      if (
        filter?.subagentRunIds !== undefined &&
        (task.runId === null || !filter.subagentRunIds.includes(task.runId))
      )
        return false;
      const omit = filter?.omitSettledSubagents;
      if (omit === undefined || (omit !== true && omit.except.includes(task.id))) return true;
      const terminal = ["completed", "failed", "cancelled", "interrupted"].includes(task.status);
      const delivered = ["acknowledged", "delivered", "disposed"].includes(
        task.completionDelivery?.state ?? "",
      );
      const active = projection.runs.some(
        (run) => run.id === task.runId && activeRunStatuses.has(run.status),
      );
      return !terminal || !delivered || active;
    }),
  };
  return Object.fromEntries([
    ["thread", projection.thread],
    ...fields.map((field) => [field, selected[field]]),
  ]) as ProjectionRecords<K>;
};

const OPEN_WORK = new Set(["pending", "running", "waiting"]);
const LIVE_RUN = new Set(["preparing", "starting", "running", "waiting"]);
const BACKGROUND_ITEM = new Set(["command_execution", "dynamic_tool", "subagent"]);

/** The replay twin of the SQLite blockers query in `layer`; keep the two in step. */
export function replayActivityBlockers(
  projections: Iterable<OrchestrationV2ThreadProjection>,
  cutoff: number,
  limit: number,
): Array<ServerActivityBlocker> {
  const found = new Map<string, { readonly at: number; readonly blocker: ServerActivityBlocker }>();
  for (const projection of projections) {
    const thread = projection.thread;
    const add = (reason: ServerActivityBlocker["reason"], at: DateTime.Utc) => {
      const key = `${thread.id}\0${reason}`;
      const millis = DateTime.toEpochMillis(at);
      const known = found.get(key);
      if (known !== undefined && known.at <= millis) return;
      found.set(key, {
        at: millis,
        blocker: {
          threadId: thread.id,
          title: thread.title,
          reason,
          since: DateTime.formatIso(at),
        },
      });
    };
    const fresh = (at: DateTime.Utc | null): at is DateTime.Utc =>
      at !== null && DateTime.toEpochMillis(at) >= cutoff;
    const afterRoot = (runId: string | null) =>
      runId === null ||
      projection.runs.some((run) => run.id === runId && run.status === "completed");
    const rootless = (nodeId: string) =>
      projection.nodes.some((node) => node.id === nodeId && node.runId === null);
    for (const run of projection.runs) {
      if (LIVE_RUN.has(run.status) || (run.status === "queued" && run.queueHeld !== true))
        add(
          run.status === "waiting" ? "waiting" : run.status === "queued" ? "queued" : "running",
          run.startedAt ?? run.requestedAt,
        );
    }
    for (const node of projection.nodes)
      if (
        OPEN_WORK.has(node.status) &&
        fresh(node.startedAt) &&
        ((node.kind === "subagent" && afterRoot(node.runId)) ||
          projection.runs.some((run) => run.id === node.runId && run.status === "queued"))
      )
        add(node.kind === "subagent" ? "background" : "running", node.startedAt);
    for (const task of projection.subagents)
      if (OPEN_WORK.has(task.status) && fresh(task.updatedAt) && afterRoot(task.runId))
        add("background", task.updatedAt);
    for (const item of projection.turnItems)
      if (
        BACKGROUND_ITEM.has(item.type) &&
        OPEN_WORK.has(item.status) &&
        fresh(item.updatedAt) &&
        afterRoot(item.runId)
      )
        add("background", item.updatedAt);
    for (const turn of projection.providerTurns)
      if (
        (turn.status === "pending" || turn.status === "running") &&
        fresh(turn.startedAt) &&
        rootless(turn.nodeId)
      )
        add("background", turn.startedAt);
    for (const request of projection.runtimeRequests)
      if (request.status === "pending" && fresh(request.createdAt) && rootless(request.nodeId))
        add("waiting", request.createdAt);
    for (const providerThread of projection.providerThreads)
      if (
        (providerThread.pendingBackgroundTasks?.length ?? 0) > 0 &&
        fresh(providerThread.updatedAt)
      )
        add("background", providerThread.updatedAt);
  }
  return Array.from(found.values())
    .sort((a, b) => a.at - b.at || a.blocker.threadId.localeCompare(b.blocker.threadId))
    .slice(0, limit)
    .map((entry) => entry.blocker);
}
