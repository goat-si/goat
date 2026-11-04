import {
  CHANNEL_GATEWAY_WS_METHODS,
  ChannelChildWork,
  ChannelGatewayError,
  ChannelTask,
  isChannelTaskTerminal,
  type BotThreadRow,
  type ChannelListBotThreadsResult,
  type ChannelTaskView,
  type ChannelUpdateTaskViewInput,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { ChannelConnectionOwner } from "./ChannelIngressContext.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as TaskViews from "./channelTaskViews.ts";

const decodeTask = Schema.decodeUnknownSync(Schema.fromJsonString(ChannelTask));
const decodeChild = Schema.decodeUnknownSync(Schema.fromJsonString(ChannelChildWork));
const failed = () => new ChannelGatewayError({ reason: "persistence_failed" });

export class ChannelBotThreads extends Context.Service<
  ChannelBotThreads,
  {
    readonly update: (
      input: ChannelUpdateTaskViewInput,
      owner: ChannelConnectionOwner,
    ) => Effect.Effect<ChannelTaskView, ChannelGatewayError>;
    readonly list: (
      owner: ChannelConnectionOwner,
    ) => Effect.Effect<ChannelListBotThreadsResult, ChannelGatewayError>;
  }
>()("goat/channels/ChannelBotThreads") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const ledger = yield* ChannelLedger.ChannelLedger;
  const views = yield* TaskViews.ChannelTaskViews;
  const list = Effect.fn("ChannelBotThreads.list")(function* (owner: ChannelConnectionOwner) {
    const bot = yield* ledger.getBot(owner.ownerId).pipe(Effect.mapError(failed));
    if (bot === undefined) return { rows: [], mainMessageCount: 0 };
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const cutoff = now - 3 * 24 * 60 * 60 * 1000;
    const counts = yield* sql<{
      readonly count: number;
    }>`SELECT count(*) AS count FROM channel_inbox i
      JOIN channel_conversations c ON c.conversation_id = i.conversation_id
      WHERE c.owner_id = ${owner.ownerId} AND c.kind = 'goat' AND c.conversation_key = ${bot.bot.threadId}
        AND i.owner_id = ${owner.ownerId} AND i.state != 'rejected'
        AND json_extract(i.message_json, '$.intent') = 'message'
        AND json_extract(i.message_json, '$.taskId') IS NULL
        AND json_extract(i.message_json, '$.actor.senderThreadId') IS NULL`.pipe(
      Effect.mapError(failed),
    );
    const rows: Array<BotThreadRow> = [];
    const seen = new Set<string>();
    let taskCount = 0;
    let cursorAt: string | undefined;
    let cursorId: string | undefined;
    while (taskCount < 100) {
      const cursor =
        cursorAt === undefined || cursorId === undefined
          ? sql``
          : sql`AND (t.updated_at < ${cursorAt} OR (t.updated_at = ${cursorAt} AND t.task_id < ${cursorId}))`;
      const source = yield* sql<{
        readonly task_json: string;
        readonly updated_at: string;
        readonly task_id: string;
      }>`SELECT t.task_json, t.updated_at, t.task_id FROM channel_tasks t
        JOIN channel_conversations c ON c.conversation_id = t.conversation_id
        WHERE t.owner_id = ${owner.ownerId} AND c.owner_id = ${owner.ownerId}
          AND c.kind = 'goat' AND c.conversation_key = ${bot.bot.threadId} ${cursor}
        ORDER BY t.updated_at DESC, t.task_id DESC LIMIT 100`.pipe(Effect.mapError(failed));
      if (source.length === 0) break;
      for (const item of source) {
        const task = yield* Effect.try(() => decodeTask(item.task_json)).pipe(
          Effect.mapError(failed),
        );
        const view = yield* views.get(task.taskId, owner);
        if (
          isChannelTaskTerminal(task.status) &&
          Date.parse(task.completedAt ?? task.updatedAt) < cutoff &&
          view.pinnedAt === null
        )
          continue;
        if (taskCount >= 100) break;
        taskCount++;
        const quiet = view.doneAt ?? task.completedAt ?? task.updatedAt;
        const since = yield* sql<{
          readonly count: number;
        }>`SELECT count(*) AS count FROM channel_inbox
        WHERE owner_id = ${owner.ownerId} AND conversation_id = ${task.conversationId}
          AND state != 'rejected' AND accepted_at > ${quiet}
          AND json_extract(message_json, '$.intent') = 'message'
          AND json_extract(message_json, '$.taskId') IS NULL
          AND json_extract(message_json, '$.actor.senderThreadId') IS NULL`.pipe(
          Effect.mapError(failed),
        );
        rows.push({
          kind: "task",
          task: {
            taskId: task.taskId,
            title: task.title,
            status: task.status,
            updatedAt: task.updatedAt,
            ...(task.completedAt === undefined ? {} : { completedAt: task.completedAt }),
          },
          view,
          lastActivityAt: task.updatedAt,
          unread:
            view.readThrough === null || Date.parse(task.updatedAt) > Date.parse(view.readThrough),
          mainMessagesSinceQuiet: since[0]?.count ?? 0,
        });
        const prefix = "child-work:" + task.taskId + ":";
        const children = yield* sql<{
          readonly value_json: string;
        }>`SELECT value_json FROM channel_runtime_state WHERE key >= ${prefix} AND key < ${prefix.slice(0, -1) + ";"} ORDER BY key`.pipe(
          Effect.mapError(failed),
        );
        for (const item of children) {
          const child = yield* Effect.try(() => decodeChild(item.value_json)).pipe(
            Effect.mapError(failed),
          );
          const threadId = child.destination?.threadId;
          if (
            child.ownerId !== owner.ownerId ||
            child.taskId !== task.taskId ||
            child.surface !== "thread_launch" ||
            threadId === undefined
          )
            continue;
          const key = bot.bot.environmentId + ":" + threadId;
          if (seen.has(key)) continue;
          seen.add(key);
          const shell = yield* sql<{
            readonly title: string;
          }>`SELECT title FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId} LIMIT 1`.pipe(
            Effect.mapError(failed),
          );
          rows.push({
            kind: "coding",
            taskId: task.taskId,
            environmentId: bot.bot.environmentId,
            threadId,
            ...(shell[0] === undefined ? {} : { title: shell[0].title }),
            state: child.state,
            lastActivityAt: child.updatedAt,
          });
        }
      }
      const last = source.at(-1);
      cursorAt = last?.updated_at;
      cursorId = last?.task_id;
      if (source.length < 100) break;
    }
    return { rows, mainMessageCount: counts[0]?.count ?? 0 };
  });
  return ChannelBotThreads.of({ list, update: views.update });
});
export const layer = Layer.effect(ChannelBotThreads, make);

export const rpcHandlers = (
  service: ChannelBotThreads["Service"],
  owner: ChannelConnectionOwner,
) => ({
  [CHANNEL_GATEWAY_WS_METHODS.listBotThreads]: () => service.list(owner),
  [CHANNEL_GATEWAY_WS_METHODS.updateTaskView]: (input: ChannelUpdateTaskViewInput) =>
    service.update(input, owner),
});
