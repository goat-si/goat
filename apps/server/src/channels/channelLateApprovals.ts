/**
 * Approvals a launched coding thread asks for after its channel task has finished, and the
 * decision when someone answers one of those approvals in the thread. The running reconcile only
 * visits tasks that are still going, and that file is at its line budget, so the pass lives here.
 *
 * @module channelLateApprovals
 */
import {
  BotId,
  ChannelChildWork,
  ChannelTask,
  channelWorkerObservationEquals,
  type ChannelTaskNeedsYou,
  type ChannelWorkerObservation,
  type OrchestrationV2RuntimeRequest,
  type ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import { replyDelivery } from "./channelReplyDelivery.ts";
import { launchObservationNeeds } from "./channelRemoteChildNeeds.ts";
import { commitTransition } from "./channelTaskWrites.ts";
import {
  isThreadMissing,
  needsYouFromRuntimeRequests,
  newApprovals,
} from "./channelWorkerObservation.ts";

/** Same window and batch as run history: recent finished tasks, a few per pass. */
const LATE_APPROVAL_DAYS = 7;
const LATE_APPROVAL_PER_PASS = 20;

const decodeTask = Schema.decodeUnknownOption(Schema.fromJsonString(ChannelTask));
const decodeChild = Schema.decodeUnknownOption(Schema.fromJsonString(ChannelChildWork));

type RequestSnapshot = Pick<
  OrchestrationV2RuntimeRequest,
  "id" | "status" | "decision" | "respondedBy"
>;

interface LateRow {
  readonly owner_id: string;
  readonly bot_id: string;
  readonly task_json: string;
  readonly pending_answer_message_id: string | null;
  readonly completion_hold: string | null;
  readonly child_json: string;
}

const accepted = (decision: string) =>
  decision === "accept" || decision === "acceptForSession" || decision === "acceptAlways";

/** The chat already said approved or denied, so the thread's own resolution is not news. */
const answeredInChat = (request: RequestSnapshot) =>
  request.respondedBy?.type === "client" && request.respondedBy.label === "GOAT Bot";

const approvalResultText = (title: string, request: RequestSnapshot) => {
  if (request.status === "expired")
    return (
      "The approval in the coding thread expired before anyone answered it. " +
      title +
      " stopped waiting."
    );
  if (request.status === "cancelled")
    return "The approval in the coding thread was cancelled. " + title + " stopped waiting.";
  return accepted(request.decision ?? "decline")
    ? "Approved in the coding thread. " + title + " continues."
    : "Denied in the coding thread. " + title + " will not do it.";
};

/**
 * One message per approval that was waiting and has now ended in the thread: decided, expired or
 * cancelled. Answering it from the chat (GOAT Bot) sends its own receipt, and an MCP requester
 * never hears one.
 */
const approvalResultDeliveries = (
  task: ChannelTask,
  requests: ReadonlyArray<RequestSnapshot>,
): ReadonlyArray<ChannelLedger.ChannelOutboxInsert> => {
  if (task.requester.originKind === "mcp") return [];
  const byId = new Map(requests.map((request) => [request.id, request]));
  return (task.observed?.needsYou ?? []).flatMap((need) => {
    const requestId = need.approval?.requestId;
    if (need.kind !== "approval" || requestId === undefined) return [];
    const request = byId.get(requestId);
    if (request === undefined || request.status === "pending" || answeredInChat(request)) return [];
    if (request.status === "resolved" && request.decision === undefined) return [];
    return [
      replyDelivery({
        causeKey: "approval-result:" + requestId,
        destination: task.originAddress,
        kind: "receipt",
        text: approvalResultText(task.title, request),
        task,
        ...(task.originAddress.kind === "slack"
          ? { mentionActorId: task.requester.externalActorId }
          : {}),
      }),
    ];
  });
};

const remoteApprovalLeft = (title: string, host: string) =>
  "The approval on " +
  host +
  " is no longer waiting in the coding thread. " +
  title +
  " continues if it was approved.";

/** The origin cannot see a remote decision, so a departed host approval is not called approved or denied. */
const departedHostApprovals = (
  task: ChannelTask,
  next: ReadonlyArray<ChannelTaskNeedsYou>,
): ReadonlyArray<ChannelLedger.ChannelOutboxInsert> => {
  if (task.requester.originKind === "mcp") return [];
  const still = new Set(next.flatMap((need) => need.approval?.requestId ?? []));
  return (task.observed?.needsYou ?? []).flatMap((need) => {
    const host = need.approval?.host;
    const requestId = need.approval?.requestId;
    if (need.kind !== "approval" || host === undefined || requestId === undefined) return [];
    if (still.has(requestId)) return [];
    return [
      replyDelivery({
        causeKey: "approval-result:" + requestId,
        destination: task.originAddress,
        kind: "receipt",
        text: remoteApprovalLeft(task.title, host),
        task,
        ...(task.originAddress.kind === "slack"
          ? { mentionActorId: task.requester.externalActorId }
          : {}),
      }),
    ];
  });
};

/**
 * Writes a worker observation and, in the same commit, any approval the thread just resolved. A
 * shown approval whose thread this pass did not read (its turn ended, so its child work is no
 * longer live) is read here so its decision is not lost.
 */

export const commitWorkerObserved = Effect.fn("channelLateApprovals.commitObserved")(function* (
  ledger: ChannelLedger.ChannelLedger["Service"],
  stored: ChannelLedger.ChannelStoredTask,
  observed: ChannelWorkerObservation,
  owner: string,
  narrate: boolean,
  requests: ReadonlyArray<RequestSnapshot>,
  threads: ThreadManagement.ThreadManagementService["Service"],
) {
  const known = new Set<string>(requests.map((request) => request.id));
  const unread = new Set(
    (stored.task.observed?.needsYou ?? []).flatMap((need) =>
      need.approval === undefined ||
      need.approval.host !== undefined ||
      known.has(need.approval.requestId)
        ? []
        : [need.approval.threadId],
    ),
  );
  const reread = yield* Effect.forEach(
    unread,
    (threadId) =>
      threads.getThreadRecords(threadId, ["runtimeRequests"]).pipe(
        Effect.map((records) => ({ threadId, requests: records.runtimeRequests })),
        Effect.catchIf(isThreadMissing, () => Effect.succeed({ threadId, requests: [] })),
        Effect.orElseSucceed(() => ({ threadId, requests: "unreadable" as const })),
      ),
    { concurrency: 1 },
  );
  const unreadable = new Set(
    reread.flatMap((read) => (read.requests === "unreadable" ? [read.threadId] : [])),
  );
  const seen = reread.flatMap((read) => (read.requests === "unreadable" ? [] : read.requests));
  const pending = new Set(
    seen.flatMap((request) => (request.status === "pending" ? [request.id] : [])),
  );
  // An approval this pass could not read, or that still waits, stays shown until its thread says.
  const kept = (stored.task.observed?.needsYou ?? []).filter(
    (need) =>
      need.approval !== undefined &&
      unread.has(need.approval.threadId) &&
      (unreadable.has(need.approval.threadId) || pending.has(need.approval.requestId)),
  );
  const next: ChannelWorkerObservation =
    kept.length === 0 ? observed : { ...observed, needsYou: [...observed.needsYou, ...kept] };
  if (channelWorkerObservationEquals(stored.task.observed, next)) return "unchanged" as const;
  const decided = approvalResultDeliveries(stored.task, [...requests, ...seen]);
  const decidedKeys = new Set(decided.map((delivery) => delivery.causeKey));
  const deliveries = [
    ...decided,
    ...departedHostApprovals(stored.task, next.needsYou).filter(
      (delivery) => !decidedKeys.has(delivery.causeKey),
    ),
  ];
  return yield* commitTransition(
    ledger,
    stored,
    {
      type: "task.worker.observed",
      payload: { generation: stored.task.generation, observed: next },
    },
    {
      owner,
      ...(narrate ? { narrate: true } : {}),
      ...(deliveries.length === 0 ? {} : { deliveries }),
    },
  );
});

const storedObservation = (
  task: ChannelTask,
  needsYou: ReadonlyArray<ChannelTaskNeedsYou>,
): ChannelWorkerObservation => {
  const previous = task.observed;
  return {
    pullRequests: previous?.pullRequests ?? [],
    needsYou,
    ...(previous?.usageLimitResetAt === undefined
      ? {}
      : { usageLimitResetAt: previous.usageLimitResetAt }),
    ...(previous?.result === undefined ? {} : { result: previous.result }),
  };
};

/**
 * Finished tasks whose current generation launched a coding thread, on this machine or another.
 * Tasks already showing an approval go first, so a decision is not stuck behind newer work.
 */
const lateRows = (sql: SqlClient.SqlClient, since: string) =>
  sql<LateRow>`
        SELECT t.owner_id, t.bot_id, t.task_json, t.pending_answer_message_id, t.completion_hold,
          c.value_json AS child_json
        FROM channel_tasks AS t
        JOIN channel_runtime_state AS c
          ON c.key >= ('child-work:' || t.task_id || ':')
         AND c.key < ('child-work:' || t.task_id || ';')
        WHERE t.task_id IN (
          SELECT task.task_id FROM channel_tasks AS task
          JOIN channel_runtime_state AS child
            ON child.key >= ('child-work:' || task.task_id || ':')
           AND child.key < ('child-work:' || task.task_id || ';')
          WHERE task.status IN ('completed', 'failed')
            AND (task.updated_at >= ${since} OR EXISTS (
              SELECT 1 FROM json_each(task.task_json, '$.observed.needsYou')
              WHERE json_extract(value, '$.kind') = 'approval'))
            AND (
              (
                json_extract(child.value_json, '$.surface') = 'thread_launch'
                AND json_extract(child.value_json, '$.destination.threadId') IS NOT NULL
                AND json_extract(child.value_json, '$.destination.host') IS NULL
              )
              OR (
                json_extract(child.value_json, '$.surface') IN ('ssh_thread_launch', 'delegate_remote')
                AND json_extract(child.value_json, '$.destination.correlationId') IS NOT NULL
                AND json_extract(child.value_json, '$.destination.host') IS NOT NULL
              )
            )
            AND json_extract(child.value_json, '$.generation') = task.generation
          GROUP BY task.task_id
          ORDER BY CASE WHEN EXISTS (
              SELECT 1 FROM json_each(task.task_json, '$.observed.needsYou')
              WHERE json_extract(value, '$.kind') = 'approval'
            ) THEN 0 ELSE 1 END, task.updated_at DESC
          LIMIT ${LATE_APPROVAL_PER_PASS}
        )
        AND (
          (
            json_extract(c.value_json, '$.surface') = 'thread_launch'
            AND json_extract(c.value_json, '$.destination.threadId') IS NOT NULL
            AND json_extract(c.value_json, '$.destination.host') IS NULL
          )
          OR (
            json_extract(c.value_json, '$.surface') IN ('ssh_thread_launch', 'delegate_remote')
            AND json_extract(c.value_json, '$.destination.correlationId') IS NOT NULL
            AND json_extract(c.value_json, '$.destination.host') IS NOT NULL
          )
        )
        AND json_extract(c.value_json, '$.generation') = t.generation
      `;

/** How many finished tasks learned about a launched thread's approvals this pass. */
export const reconcileLateApprovals = Effect.fn("channelLateApprovals.reconcile")(
  function* (
    owner: string,
    deps: {
      readonly ledger: ChannelLedger.ChannelLedger["Service"];
      readonly threads: ThreadManagement.ThreadManagementService["Service"];
      readonly sql: SqlClient.SqlClient;
    },
  ) {
    const now = yield* DateTime.now;
    const since = DateTime.formatIso(DateTime.subtract(now, { days: LATE_APPROVAL_DAYS }));
    const rows = yield* lateRows(deps.sql, since);
    const groups = new Map<
      string,
      {
        readonly stored: ChannelLedger.ChannelStoredTask;
        readonly threadIds: Array<ThreadId>;
        readonly remote: Array<{ readonly correlationId: string; readonly host: string }>;
      }
    >();
    for (const row of rows) {
      const decodedTask = decodeTask(row.task_json);
      const decodedChild = decodeChild(row.child_json);
      if (Option.isNone(decodedTask) || Option.isNone(decodedChild)) continue;
      const task = decodedTask.value;
      const child = decodedChild.value;
      const destination = child.destination;
      const remote =
        (child.surface === "ssh_thread_launch" || child.surface === "delegate_remote") &&
        child.generation === task.generation &&
        destination?.correlationId !== undefined &&
        destination.host !== undefined
          ? { correlationId: destination.correlationId, host: destination.host }
          : undefined;
      const threadId =
        child.surface === "thread_launch" &&
        child.generation === task.generation &&
        destination?.threadId !== undefined &&
        destination.host === undefined
          ? destination.threadId
          : undefined;
      if (remote === undefined && threadId === undefined) continue;
      const existing = groups.get(task.taskId);
      if (existing === undefined) {
        groups.set(task.taskId, {
          stored: {
            ownerId: row.owner_id,
            botId: BotId.make(row.bot_id),
            task,
            pendingAnswerMessageId: row.pending_answer_message_id ?? undefined,
            completionHold: row.completion_hold ?? undefined,
          },
          threadIds: threadId === undefined ? [] : [threadId],
          remote: remote === undefined ? [] : [remote],
        });
      } else {
        if (threadId !== undefined && !existing.threadIds.includes(threadId))
          existing.threadIds.push(threadId);
        if (
          remote !== undefined &&
          !existing.remote.some((item) => item.correlationId === remote.correlationId)
        )
          existing.remote.push(remote);
      }
    }

    let changed = 0;
    for (const { stored, threadIds, remote } of groups.values()) {
      const requests: Array<OrchestrationV2RuntimeRequest & { readonly threadId: ThreadId }> = [];
      let unreadable = false;
      for (const threadId of threadIds) {
        const read = yield* deps.threads
          .getThreadRecords(threadId, ["runtimeRequests"])
          .pipe(Effect.result);
        if (read._tag === "Failure") {
          if (!isThreadMissing(read.failure)) unreadable = true;
          continue;
        }
        for (const request of read.success.runtimeRequests) requests.push({ ...request, threadId });
      }
      // A failed read must not clear an approval the pass could not see.
      if (unreadable) continue;
      const remoteNeeds = yield* launchObservationNeeds(
        deps.sql,
        remote,
        stored.task.observed?.needsYou,
      );
      const approvals = [
        ...needsYouFromRuntimeRequests(requests, (request) => request.threadId).filter(
          (need) => need.kind === "approval",
        ),
        ...remoteNeeds,
      ];
      const observed = storedObservation(stored.task, approvals);
      if (channelWorkerObservationEquals(stored.task.observed, observed)) continue;
      const narrate =
        stored.task.requester.originKind !== "mcp" &&
        newApprovals(stored.task.observed?.needsYou, approvals).length > 0;
      const wrote = yield* commitWorkerObserved(
        deps.ledger,
        stored,
        observed,
        owner,
        narrate,
        requests,
        deps.threads,
      );
      if (wrote !== undefined && wrote !== "unchanged") changed += 1;
    }
    return changed;
  },
  // The rest of reconcile has already run; a failed pass is retried on the next one.
  Effect.catchCause((cause) =>
    Effect.logWarning("late launched-thread approvals not read", { cause }).pipe(Effect.as(0)),
  ),
);
