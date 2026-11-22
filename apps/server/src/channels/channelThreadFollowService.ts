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
  type ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { ChannelConnectionOwner } from "./ChannelIngressContext.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import { deliveryIdFor } from "./channelIds.ts";
import { makeThreadFollows } from "./channelThreadFollows.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const isGatewayError = Schema.is(ChannelGatewayError);
const failed = () => new ChannelGatewayError({ reason: "persistence_failed" });
const missing = () => new ChannelGatewayError({ reason: "not_found" });

export const makeThreadFollowService = Effect.fn("ChannelThreadFollowService.make")(function* (
  ledger: ChannelLedger.ChannelLedger["Service"],
) {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* makeThreadFollows();
  const read = Effect.fn("ChannelThreadFollowService.read")(function* (threadId: ThreadId) {
    const [row] = yield* sql<{
      run_id: string | null;
      status: string;
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
      (follow) =>
        read(follow.threadId).pipe(
          Effect.map((row) =>
            row === undefined
              ? "Followed thread is unavailable."
              : [
                  "Followed thread " + follow.threadId + " is " + row.status + ".",
                  ...(row.run_id === null ? [] : ["Run " + row.run_id + "."]),
                  ...(typeof row.pull_request === "string" ? ["PR " + row.pull_request] : []),
                ]
                  .join(" ")
                  .slice(0, 4_000),
          ),
        ),
      (follow, text, accessLost) =>
        Effect.gen(function* () {
          const bot = yield* ledger.getBotById(follow.ownerId, follow.botId);
          if (bot === undefined || bot.bot.environmentId !== follow.environmentId) return;
          const causeKey =
            "follow:" +
            encodeJson([
              follow.ownerId,
              follow.botId,
              follow.environmentId,
              follow.threadId,
              follow.taskId,
              text,
            ]);
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
