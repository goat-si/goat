import {
  BotId,
  CHANNEL_GATEWAY_WS_METHODS,
  ChannelChildWork,
  ChannelGatewayError,
  ChannelTask,
  type BotThreadRow,
  type ChannelListBotThreadsInput,
  type ChannelListBotThreadsResult,
  ChannelTaskView,
  type ChannelListChildWorkInput,
  type ChannelListChildWorkResult,
  type ChannelRetryTaskInput,
  type ChannelRetryTaskResult,
  type ChannelUpdateTaskViewInput,
  GoatBotWorkKind,
  MAIN_BOT_ID,
  ProjectId,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import type { ChannelConnectionOwner } from "./ChannelIngressContext.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelChildWorkStore from "./channelChildWorkStore.ts";
import { listChildWork } from "./listChildWork.ts";
import * as TaskViews from "./channelTaskViews.ts";
import { makeTaskRetry } from "./channelTaskRetry.ts";

const decodeTask = Schema.decodeUnknownSync(Schema.fromJsonString(ChannelTask));
const decodeView = Schema.decodeUnknownSync(Schema.fromJsonString(ChannelTaskView));
const decodeChild = Schema.decodeUnknownSync(Schema.fromJsonString(ChannelChildWork));
const isWorkKind = Schema.is(GoatBotWorkKind);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
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
      botId?: BotId,
    ) => Effect.Effect<ChannelListBotThreadsResult, ChannelGatewayError>;
    readonly listChildWork: (
      input: ChannelListChildWorkInput,
      owner: ChannelConnectionOwner,
    ) => Effect.Effect<ChannelListChildWorkResult, ChannelGatewayError>;
    /** A person runs a failed or stopped task again as its next attempt. */
    readonly retry: (
      input: ChannelRetryTaskInput,
      owner: ChannelConnectionOwner,
    ) => Effect.Effect<ChannelRetryTaskResult, ChannelGatewayError>;
  }
>()("goat/channels/ChannelBotThreads") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const ledger = yield* ChannelLedger.ChannelLedger;
  const views = yield* TaskViews.ChannelTaskViews;
  const childWork = yield* ChannelChildWorkStore.ChannelChildWorkStore;
  const retry = yield* makeTaskRetry;
  const list = Effect.fn("ChannelBotThreads.list")(function* (
    owner: ChannelConnectionOwner,
    botId: BotId = BotId.make(MAIN_BOT_ID),
  ) {
    yield* ledger.ensureTaskBotsRepaired().pipe(Effect.mapError(failed));
    const bot = yield* ledger.getBotById(owner.ownerId, botId).pipe(Effect.mapError(failed));
    if (bot === undefined) return { rows: [], mainMessageCount: 0 };
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const cutoff = now - 3 * 24 * 60 * 60 * 1000;
    const counts = yield* sql<{
      readonly count: number;
    }>`SELECT count(*) AS count FROM channel_inbox i
      JOIN channel_conversations c ON c.conversation_id = i.conversation_id
      WHERE c.owner_id = ${owner.ownerId} AND c.kind = 'goat'
        AND i.owner_id = ${owner.ownerId} AND i.bot_id = ${botId} AND i.state != 'rejected'
        AND json_extract(i.message_json, '$.intent') = 'message'
        AND json_extract(i.message_json, '$.taskId') IS NULL
        AND json_extract(i.message_json, '$.actor.senderThreadId') IS NULL`.pipe(
      Effect.mapError(failed),
    );
    const viewPrefix = "task-view:" + encodeURIComponent(owner.ownerId) + ":";
    const viewRows = yield* sql<{
      readonly key: string;
      readonly value_json: string;
    }>`SELECT key, value_json
      FROM channel_runtime_state WHERE key >= ${viewPrefix} AND key < ${viewPrefix.slice(0, -1) + ";"}`.pipe(
      Effect.mapError(failed),
    );
    const decodedViews = yield* Effect.try(() =>
      viewRows.map((row) => {
        const view = decodeView(row.value_json);
        if (row.key !== viewPrefix + encodeURIComponent(view.taskId))
          throw new Error("Invalid task view key");
        return view;
      }),
    ).pipe(Effect.mapError(failed));
    const viewsByTask = new Map(decodedViews.map((view) => [view.taskId, view]));
    const pinned = encodeJson(
      decodedViews.filter((view) => view.pinnedAt !== null).map((view) => view.taskId),
    );
    const cutoffIso = DateTime.formatIso(DateTime.makeUnsafe(cutoff));
    const source = yield* sql<{
      readonly task_json: string;
    }>`SELECT t.task_json FROM channel_tasks t
      JOIN channel_conversations c ON c.conversation_id = t.conversation_id
      WHERE t.owner_id = ${owner.ownerId} AND t.bot_id = ${botId} AND c.owner_id = ${owner.ownerId}
        AND c.kind = 'goat'
        AND ((COALESCE(json_extract(t.task_json, '$.kind'), 'work') != 'turn'
          AND (t.status NOT IN ('completed', 'failed', 'cancelled')
            OR COALESCE(json_extract(t.task_json, '$.completedAt'), t.updated_at) >= ${cutoffIso}
            OR t.task_id IN (SELECT value FROM json_each(${pinned}))))
          -- The bot's own turn shows only while work it launched still runs; its reply is in the chat.
          OR (json_extract(t.task_json, '$.kind') = 'turn' AND EXISTS (
            SELECT 1 FROM channel_runtime_state s
            WHERE s.key >= ('child-work:' || t.task_id || ':') AND s.key < ('child-work:' || t.task_id || ';')
              AND json_extract(s.value_json, '$.generation') = t.generation
              AND json_extract(s.value_json, '$.state') IN ('launched', 'bound', 'unknown'))))
      ORDER BY t.updated_at DESC, t.task_id DESC LIMIT 100`.pipe(Effect.mapError(failed));
    const tasks = yield* Effect.try(() => source.map((item) => decodeTask(item.task_json))).pipe(
      Effect.mapError(failed),
    );
    const countInputs = encodeJson(
      tasks.map((task) => ({
        taskId: task.taskId,
        conversationId: task.conversationId,
        quiet: [task.completedAt ?? task.updatedAt, viewsByTask.get(task.taskId)?.doneAt ?? ""]
          .sort()
          .at(-1),
      })),
    );
    const countsByTask = yield* sql<{ readonly task_id: string; readonly count: number }>`SELECT
      json_extract(target.value, '$.taskId') AS task_id, count(i.input_id) AS count
      FROM json_each(${countInputs}) target LEFT JOIN channel_inbox i
        ON i.owner_id = ${owner.ownerId}
        AND i.conversation_id = json_extract(target.value, '$.conversationId')
        AND i.state != 'rejected' AND i.accepted_at > json_extract(target.value, '$.quiet')
        AND json_extract(i.message_json, '$.intent') = 'message'
        AND json_extract(i.message_json, '$.taskId') IS NULL
        AND json_extract(i.message_json, '$.actor.senderThreadId') IS NULL
      GROUP BY json_extract(target.value, '$.taskId')`.pipe(Effect.mapError(failed));
    const countMap = new Map(countsByTask.map((item) => [item.task_id, item.count]));
    const childRows = yield* sql<{
      readonly value_json: string;
      readonly title: string | null;
      readonly project_id: string | null;
      readonly work_kind: unknown;
    }>`SELECT s.value_json, p.title, p.project_id,
        json_extract(p.payload_json, '$.launchedBy.workKind') AS work_kind
      FROM channel_runtime_state s
      JOIN json_each(${encodeJson(tasks.map((task) => task.taskId))}) ids
        ON s.key >= ('child-work:' || ids.value || ':') AND s.key < ('child-work:' || ids.value || ';')
      LEFT JOIN orchestration_v2_projection_threads p ON p.thread_id = json_extract(s.value_json, '$.destination.threadId')
      ORDER BY s.key`.pipe(Effect.mapError(failed));
    const children = yield* Effect.try(() =>
      childRows.map((item) => ({
        child: decodeChild(item.value_json),
        title: item.title,
        projectId: item.project_id,
        recordedKind: isWorkKind(item.work_kind) ? item.work_kind : undefined,
      })),
    ).pipe(Effect.mapError(failed));
    // Launches from before work kinds were recorded: one in Scratch was a chore.
    const folders = yield* Effect.serviceOption(ManagedProjectFolders.ManagedProjectFolders);
    const workKindOf = (projectId: string | null, recorded: GoatBotWorkKind | undefined) =>
      recorded !== undefined || projectId === null || Option.isNone(folders)
        ? Effect.succeed(recorded)
        : folders.value
            .isScratchProject(ProjectId.make(projectId))
            .pipe(Effect.map((scratch) => (scratch ? ("chore" as const) : undefined)));
    const rows: Array<BotThreadRow> = [];
    const seen = new Set<string>();
    for (const task of tasks) {
      const view = viewsByTask.get(task.taskId) ?? {
        taskId: task.taskId,
        pinnedAt: null,
        doneAt: null,
        readThrough: null,
      };
      rows.push({
        kind: "task",
        task: {
          taskId: task.taskId,
          title: task.title,
          status: task.status,
          updatedAt: task.updatedAt,
          ...(task.completedAt === undefined ? {} : { completedAt: task.completedAt }),
          ...(task.generation > 1 ? { generation: task.generation } : {}),
        },
        view,
        lastActivityAt: task.updatedAt,
        unread:
          view.readThrough === null || Date.parse(task.updatedAt) > Date.parse(view.readThrough),
        mainMessagesSinceQuiet: countMap.get(task.taskId) ?? 0,
        // A worker on another machine is not a thread this machine's rows can open.
        ...(task.worker === undefined || task.worker.host !== undefined
          ? {}
          : {
              worker: {
                environmentId: task.worker.environmentId,
                threadId: task.worker.threadId,
              },
            }),
      });
      for (const { child, title, projectId, recordedKind } of children) {
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
        const workKind = yield* workKindOf(projectId, recordedKind);
        rows.push({
          kind: "coding",
          taskId: task.taskId,
          environmentId: bot.bot.environmentId,
          threadId,
          ...(title === null ? {} : { title }),
          state: child.state,
          lastActivityAt: child.updatedAt,
          ...(workKind === undefined ? {} : { workKind }),
        });
      }
    }
    return { rows, mainMessageCount: counts[0]?.count ?? 0 };
  });
  const listChildWorkFor = Effect.fn("ChannelBotThreads.listChildWork")(function* (
    input: ChannelListChildWorkInput,
    owner: ChannelConnectionOwner,
  ) {
    return yield* listChildWork(ledger, childWork, owner.ownerId, input);
  });
  return ChannelBotThreads.of({
    list,
    update: views.update,
    listChildWork: listChildWorkFor,
    retry,
  });
});
export const layer = Layer.effect(ChannelBotThreads, make);

export const rpcHandlers = (
  service: ChannelBotThreads["Service"],
  owner: ChannelConnectionOwner,
) => ({
  [CHANNEL_GATEWAY_WS_METHODS.listBotThreads]: (input: ChannelListBotThreadsInput) =>
    service.list(owner, input.botId),
  [CHANNEL_GATEWAY_WS_METHODS.updateTaskView]: (input: ChannelUpdateTaskViewInput) =>
    service.update(input, owner),
  [CHANNEL_GATEWAY_WS_METHODS.listChildWork]: (input: ChannelListChildWorkInput) =>
    service.listChildWork(input, owner),
  [CHANNEL_GATEWAY_WS_METHODS.retryTask]: (input: ChannelRetryTaskInput) =>
    service.retry(input, owner),
});
