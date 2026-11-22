import {
  type AuthSessionId,
  type BotId,
  CHANNEL_GATEWAY_WS_METHODS,
  type ChannelFollowTarget,
  type ChannelFollowThreadInput,
  ChannelGatewayError,
  type ChannelListFollowedThreadsInput,
  type EnvironmentId,
  isGoatBotSessionThreadId,
  type OrchestrationV2RunStatus,
  type ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { isTerminalRunStatus } from "../orchestration-v2/ThreadManagementService.ts";
import type { ChannelConnectionOwner } from "./ChannelIngressContext.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import { deliveryIdFor } from "./channelIds.ts";
import { makeThreadFollows } from "./channelThreadFollows.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const isGatewayError = Schema.is(ChannelGatewayError);
const failed = () => new ChannelGatewayError({ reason: "persistence_failed" });
function observation(
  threadId: ThreadId,
  status: OrchestrationV2RunStatus | "idle",
  runId: string | null,
  pullRequest: string | null,
) {
  return {
    text: [
      "Followed thread " + threadId + " is " + status + ".",
      ...(runId === null ? [] : ["Run " + runId + "."]),
      ...(pullRequest === null ? [] : ["PR " + pullRequest]),
    ]
      .join(" ")
      .slice(0, 4_000),
    ...(runId !== null && status !== "idle" && isTerminalRunStatus(status)
      ? { terminalRunId: runId }
      : {}),
  };
}

const missing = () => new ChannelGatewayError({ reason: "not_found" });

export const makeThreadFollowService = Effect.fn("ChannelThreadFollowService.make")(function* (
  ledger: ChannelLedger.ChannelLedger["Service"],
) {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* makeThreadFollows();
  const read = Effect.fn("ChannelThreadFollowService.read")(function* (threadId: ThreadId) {
    const [row] = yield* sql<{
      run_id: string | null;
      status: OrchestrationV2RunStatus | "idle";
      pull_request: string | null;
    }>`
      SELECT run.run_id, coalesce(run.status, 'idle') AS status,
        (SELECT json_extract(link.value, '$.url')
         FROM json_each(p.payload_json, '$.pullRequests') AS link
         WHERE json_extract(link.value, '$.source') IS NOT 'stack-dismissed'
         LIMIT 1) AS pull_request
      FROM orchestration_v2_projection_threads p
      LEFT JOIN orchestration_v2_projection_runs run ON run.run_id = (
        SELECT run_id FROM orchestration_v2_projection_runs
        WHERE thread_id = p.thread_id ORDER BY ordinal DESC LIMIT 1
      )
      WHERE p.thread_id = ${threadId} AND p.deleted_at IS NULL
    `;
    return row;
  });

  const list = Effect.fn("ChannelThreadFollowService.list")(function* (
    ownerId: string,
    botId: BotId,
  ) {
    const records = yield* store.list(ownerId, botId);
    return (yield* Effect.forEach(records, (record) =>
      read(record.threadId).pipe(
        Effect.map((row) =>
          row === undefined
            ? []
            : [
                {
                  ...record,
                  status: row.status,
                  ...(typeof row.pull_request === "string"
                    ? { pullRequest: row.pull_request }
                    : {}),
                },
              ],
        ),
      ),
    )).flat();
  });

  const settle = Effect.fn("ChannelThreadFollowService.settle")(function* (
    target: ChannelFollowTarget & { ownerId: string },
  ) {
    yield* store.settle(
      target,
      Effect.fn("ChannelThreadFollowService.observe")(function* (follow) {
        const row = yield* read(follow.threadId);
        if (row === undefined) {
          return {
            snapshot: { text: "Followed thread is unavailable." },
            eventCursor: follow.eventCursor,
          };
        }
        const snapshot = observation(follow.threadId, row.status, row.run_id, row.pull_request);
        if (follow.eventCursor === undefined) {
          const [head] = yield* sql<{ sequence: number }>`
            SELECT coalesce(max(sequence), 0) AS sequence FROM orchestration_events
            WHERE application_event_version = 2 AND aggregate_kind = 'thread'
              AND stream_id = ${follow.threadId}
          `;
          return { snapshot, eventCursor: head?.sequence ?? 0 };
        }
        const events = yield* sql<{
          sequence: number;
          run_id: string | null;
          status: OrchestrationV2RunStatus | null;
        }>`
          SELECT sequence,
            CASE WHEN event_type IN ('run.created', 'run.updated')
              THEN json_extract(payload_json, '$.id') END AS run_id,
            CASE WHEN event_type IN ('run.created', 'run.updated')
              THEN json_extract(payload_json, '$.status') END AS status
          FROM orchestration_events
          WHERE application_event_version = 2 AND aggregate_kind = 'thread'
            AND stream_id = ${follow.threadId} AND sequence > ${follow.eventCursor}
          ORDER BY sequence LIMIT 100
        `;
        const endings = events.flatMap(({ run_id, status }) =>
          run_id !== null && status !== null && isTerminalRunStatus(status)
            ? [
                {
                  ...observation(follow.threadId, status, run_id, row.pull_request),
                  terminalRunId: run_id,
                },
              ]
            : [],
        );
        return { snapshot, endings, eventCursor: events.at(-1)?.sequence ?? follow.eventCursor };
      }),
      (follow, { text, terminalRunId }, instance, accessLost) =>
        Effect.gen(function* () {
          const bot = yield* ledger.getBotById(follow.ownerId, follow.botId);
          if (bot === undefined || bot.bot.environmentId !== follow.environmentId) return;
          const causeKey =
            "follow:" +
            encodeJson(
              terminalRunId === undefined
                ? [instance.id, "snapshot", text]
                : [instance.id, "terminal", terminalRunId],
            );
          const deliveryId = deliveryIdFor(causeKey);
          yield* ledger.enqueueDeliveries(
            [
              {
                causeKey,
                deliveryId,
                taskId: follow.taskId,
                message: {
                  deliveryId,
                  destination: {
                    kind: "goat",
                    environmentId: follow.environmentId,
                    threadId: bot.bot.threadId,
                  },
                  kind: "receipt",
                  text,
                  ...(accessLost
                    ? {}
                    : {
                        followApproval: {
                          sessionId: follow.sessionId,
                          principalId: follow.principalId,
                          instance,
                        },
                      }),
                  taskId: follow.taskId,
                },
              },
            ],
            DateTime.formatIso(yield* DateTime.now),
          );
        }),
    );
  });

  const start = Effect.fn("ChannelThreadFollowService.start")(function* (
    input: ChannelFollowThreadInput,
    owner: ChannelConnectionOwner,
    environmentId: EnvironmentId,
    sessionId: AuthSessionId,
  ) {
    if (input.environmentId !== environmentId)
      return yield* new ChannelGatewayError({ reason: "cross_environment_follow" });
    const bot = yield* ledger.getBotById(owner.ownerId, input.botId).pipe(Effect.mapError(failed));
    if (bot === undefined) return yield* missing();
    if (bot.bot.environmentId !== environmentId)
      return yield* new ChannelGatewayError({ reason: "cross_environment_follow" });
    const task = yield* ledger.getTask(input.taskId).pipe(Effect.mapError(failed));
    if (
      task?.ownerId !== owner.ownerId ||
      task.botId !== input.botId ||
      isGoatBotSessionThreadId(input.threadId)
    )
      return yield* missing();
    const target = { ...input, ownerId: owner.ownerId };
    const inserted = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const inserted = yield* store.start({
            ...target,
            sessionId,
            principalId: owner.principalId,
          });
          if (inserted) {
            if ((yield* read(input.threadId)) === undefined) return yield* missing();
            yield* settle(target);
          }
          return inserted;
        }),
      )
      .pipe(Effect.mapError((error) => (isGatewayError(error) ? error : failed())));
    return inserted;
  });

  let cursor = "";
  const reconcile = Effect.fn("ChannelThreadFollowService.reconcile")(function* () {
    const page = yield* store.records("thread-follow:", cursor);
    for (const { follow } of page) {
      yield* settle(follow).pipe(
        Effect.catch((cause) => Effect.logWarning("Thread follow observation failed", { cause })),
      );
    }
    cursor = page.length === 100 ? (page.at(-1)?.key ?? "") : "";
  });

  return {
    list,
    reconcile,
    rpcHandlers: (
      owner: ChannelConnectionOwner,
      environmentId: EnvironmentId,
      sessionId: AuthSessionId,
    ) => ({
      [CHANNEL_GATEWAY_WS_METHODS.followThread]: (input: ChannelFollowThreadInput) =>
        start(input, owner, environmentId, sessionId),
      [CHANNEL_GATEWAY_WS_METHODS.stopFollowingThread]: Effect.fn(
        "ChannelThreadFollowService.stop",
      )(function* (input: ChannelFollowTarget) {
        if (
          !(yield* store
            .mayRead({ sessionId, principalId: owner.principalId }, true)
            .pipe(Effect.mapError(failed)))
        )
          return yield* new ChannelGatewayError({ reason: "forbidden" });
        yield* store.stop({ ...input, ownerId: owner.ownerId }).pipe(Effect.mapError(failed));
      }),
      [CHANNEL_GATEWAY_WS_METHODS.listFollowedThreads]: (input: ChannelListFollowedThreadsInput) =>
        list(owner.ownerId, input.botId).pipe(
          Effect.map((followedThreads) => ({ followedThreads })),
          Effect.mapError(failed),
        ),
    }),
  };
});
