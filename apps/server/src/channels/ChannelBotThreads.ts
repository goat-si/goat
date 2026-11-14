import {
  BotId,
  CHANNEL_GATEWAY_WS_METHODS,
  ChannelChildWork,
  ChannelGatewayError,
  ChannelTask,
  ChannelConversationId,
  type BotRemoteWork,
  type BotThreadRow,
  CHANNEL_BOT_THREADS_HISTORY_LAUNCHES,
  type ChannelListBotThreadsInput,
  type ChannelListBotThreadsResult,
  ChannelTaskView,
  EnvironmentId,
  type ChannelListChildWorkInput,
  type ChannelListChildWorkResult,
  type ChannelRetryTaskInput,
  type ChannelRetryTaskResult,
  type ChannelUpdateTaskViewInput,
  type ChannelGetBotTaskInput,
  type ChannelSearchBotTasksInput,
  type ChannelSearchBotTasksResult,
  type BotWorkResult,
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
import {
  decodeHistoryCursor,
  launchesStatement,
  quietMessagesStatement,
  readHistoryPage,
} from "./channelBotThreadHistory.ts";
import * as TaskViews from "./channelTaskViews.ts";
import { makeTaskRetry } from "./channelTaskRetry.ts";
import { cutBotWorkTitle, searchBotTasks as searchTasks } from "./channelBotTaskSearch.ts";

const decodeTask = Schema.decodeUnknownSync(Schema.fromJsonString(ChannelTask));
const decodeView = Schema.decodeUnknownSync(Schema.fromJsonString(ChannelTaskView));
const decodeChild = Schema.decodeUnknownSync(Schema.fromJsonString(ChannelChildWork));
const isWorkKind = Schema.is(GoatBotWorkKind);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const failed = () => new ChannelGatewayError({ reason: "persistence_failed" });
interface ChildRow {
  readonly key?: string;
  readonly value_json: string;
  readonly title: string | null;
  readonly project_id: string | null;
  readonly work_kind: unknown;
}

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
      history?: { readonly cursor?: string },
    ) => Effect.Effect<ChannelListBotThreadsResult, ChannelGatewayError>;
    readonly listChildWork: (
      input: ChannelListChildWorkInput,
      owner: ChannelConnectionOwner,
    ) => Effect.Effect<ChannelListChildWorkResult, ChannelGatewayError>;
    readonly getBotTask: (
      input: ChannelGetBotTaskInput,
      owner: ChannelConnectionOwner,
    ) => Effect.Effect<BotWorkResult, ChannelGatewayError>;
    readonly searchBotTasks: (
      input: ChannelSearchBotTasksInput,
      owner: ChannelConnectionOwner,
    ) => Effect.Effect<ChannelSearchBotTasksResult, ChannelGatewayError>;
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
  /** Rows for these tasks; history caps each task's launches and lists turns by their threads. */
  const rowsFor = Effect.fn("ChannelBotThreads.rows")(function* (
    owner: ChannelConnectionOwner,
    environmentId: EnvironmentId,
    viewsByTask: ReadonlyMap<string, ChannelTaskView>,
    tasks: ReadonlyArray<ChannelTask>,
    options: {
      readonly threadsOnly?: ReadonlySet<string>;
      readonly launchLimit?: number;
      readonly unknownView?: boolean;
    },
  ) {
    const countInputs = encodeJson(
      tasks.map((task) => ({
        taskId: task.taskId,
        conversationId: task.conversationId,
        quiet: [task.completedAt ?? task.updatedAt, viewsByTask.get(task.taskId)?.doneAt ?? ""]
          .sort()
          .at(-1),
      })),
    );
    const countsByTask = yield* (
      options.launchLimit === undefined
        ? sql<{ readonly task_id: string; readonly count: number }>`SELECT
      json_extract(target.value, '$.taskId') AS task_id, count(i.input_id) AS count
      FROM json_each(${countInputs}) target LEFT JOIN channel_inbox i
        ON i.owner_id = ${owner.ownerId}
        AND i.conversation_id = json_extract(target.value, '$.conversationId')
        AND i.state != 'rejected' AND i.accepted_at > json_extract(target.value, '$.quiet')
        AND json_extract(i.message_json, '$.intent') = 'message'
        AND json_extract(i.message_json, '$.taskId') IS NULL
        AND json_extract(i.message_json, '$.actor.senderThreadId') IS NULL
      GROUP BY json_extract(target.value, '$.taskId')`
        : quietMessagesStatement(sql, { ownerId: owner.ownerId, inputs: countInputs })
    ).pipe(Effect.mapError(failed));
    const countMap = new Map(countsByTask.map((item) => [item.task_id, item.count]));
    const taskIds = encodeJson(tasks.map((task) => task.taskId));
    const launchLimit = options.launchLimit;
    // Truncation comes from the raw lookahead, before decoding, so a record that fails to decode
    // cannot hide that a task has more launches than the page lists.
    const truncated = new Set<string>();
    const childRows: ReadonlyArray<ChildRow> =
      launchLimit === undefined
        ? yield* sql<ChildRow>`SELECT s.value_json, p.title, p.project_id,
        json_extract(p.payload_json, '$.launchedBy.workKind') AS work_kind
      FROM channel_runtime_state s
      JOIN json_each(${taskIds}) ids
        ON s.key >= ('child-work:' || ids.value || ':') AND s.key < ('child-work:' || ids.value || ';')
      -- Only a local launch's thread is in this machine's projection; a remote one with the same
      -- id is another thread.
      LEFT JOIN orchestration_v2_projection_threads p
        ON json_extract(s.value_json, '$.surface') = 'thread_launch'
        AND json_extract(s.value_json, '$.destination.host') IS NULL
        AND p.thread_id = json_extract(s.value_json, '$.destination.threadId')
      ORDER BY s.key`.pipe(Effect.mapError(failed))
        : // History seeks each task's newest launches, one more to tell whether there are more.
          (yield* Effect.forEach(tasks, (task) =>
            launchesStatement(sql, {
              ownerId: owner.ownerId,
              taskId: task.taskId,
              limit: launchLimit + 1,
            }).pipe(
              Effect.map((rows) => {
                if (rows.length > launchLimit) truncated.add(task.taskId);
                return rows.slice(0, launchLimit);
              }),
              Effect.mapError(failed),
            ),
          ))
            .flat()
            .toSorted((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const decodeRow = (item: ChildRow) => ({
      child: decodeChild(item.value_json),
      title: item.title,
      projectId: item.project_id,
      recordedKind: isWorkKind(item.work_kind) ? item.work_kind : undefined,
    });
    let skippedLaunches = 0;
    const children =
      launchLimit === undefined
        ? yield* Effect.try(() => childRows.map(decodeRow)).pipe(Effect.mapError(failed))
        : // History leaves out and counts a record it cannot read rather than failing the page.
          (yield* Effect.forEach(childRows, (item) =>
            Effect.try(() => [decodeRow(item)]).pipe(
              Effect.orElseSucceed(() => {
                skippedLaunches += 1;
                return [];
              }),
            ),
          )).flat();
    // Launches from before work kinds were recorded: one in Scratch was a chore.
    const folders = yield* Effect.serviceOption(ManagedProjectFolders.ManagedProjectFolders);
    const workKindOf = (projectId: string | null, recorded: GoatBotWorkKind | undefined) =>
      recorded !== undefined || projectId === null || Option.isNone(folders)
        ? Effect.succeed(recorded)
        : folders.value
            .isScratchProject(ProjectId.make(projectId))
            .pipe(Effect.map((scratch) => (scratch ? ("chore" as const) : undefined)));
    const rows: Array<BotThreadRow> = [];
    const remoteWork: Array<BotRemoteWork> = [];
    const seen = new Set<string>();
    const launchesTruncated = tasks.flatMap((task) =>
      truncated.has(task.taskId) ? [task.taskId] : [],
    );
    for (const task of tasks) {
      if (!options.unknownView && !options.threadsOnly?.has(task.taskId)) {
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
      }
      for (const { child, title, projectId, recordedKind } of children) {
        if (child.ownerId !== owner.ownerId || child.taskId !== task.taskId) continue;
        const destination = child.destination;
        // Work on another machine is listed by its record alone; one never launched ran nothing.
        if (child.surface === "ssh_thread_launch") {
          // History lists a released launch that got its remote thread, which it can open.
          const ran = launchLimit !== undefined && destination?.threadId !== undefined;
          if (destination?.host === undefined || (child.state === "released" && !ran)) continue;
          remoteWork.push({
            childWorkId: child.childWorkId,
            taskId: task.taskId,
            callerThreadId: child.callerThreadId,
            host: destination.host,
            state: child.state,
            lastActivityAt: child.updatedAt,
            ...(destination.threadId === undefined ? {} : { threadId: destination.threadId }),
            ...(destination.environmentId === undefined
              ? {}
              : { environmentId: destination.environmentId }),
            ...(destination.workKind === undefined ? {} : { workKind: destination.workKind }),
          });
          continue;
        }
        const threadId = destination?.threadId;
        if (child.surface !== "thread_launch" || threadId === undefined) continue;
        const key = environmentId + ":" + threadId;
        if (seen.has(key)) continue;
        seen.add(key);
        const workKind = yield* workKindOf(projectId, recordedKind);
        rows.push({
          kind: "coding",
          taskId: task.taskId,
          environmentId,
          threadId,
          ...(title === null ? {} : { title }),
          state: child.state,
          lastActivityAt: child.updatedAt,
          ...(workKind === undefined ? {} : { workKind }),
        });
      }
    }
    return { rows, remoteWork, launchesTruncated, skippedLaunches };
  });
  const mainMessageCount = Effect.fn("ChannelBotThreads.mainMessageCount")(function* (
    owner: ChannelConnectionOwner,
    botId: BotId,
  ) {
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
    return counts[0]?.count ?? 0;
  });
  // Traced once by list below.
  const current = Effect.fnUntraced(function* (
    owner: ChannelConnectionOwner,
    botId: BotId,
    environmentId: EnvironmentId,
  ) {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const cutoff = now - 3 * 24 * 60 * 60 * 1000;
    const messages = yield* mainMessageCount(owner, botId);
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
      readonly updated_at: string;
      readonly task_id: string;
    }>`SELECT t.task_json, t.updated_at, t.task_id FROM channel_tasks t
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
      ORDER BY (t.task_id IN (SELECT value FROM json_each(${pinned}))) DESC,
        t.updated_at DESC, t.task_id DESC LIMIT 100`.pipe(Effect.mapError(failed));
    const ordered = [...source].sort(
      (a, b) =>
        Buffer.compare(Buffer.from(b.updated_at), Buffer.from(a.updated_at)) ||
        Buffer.compare(Buffer.from(b.task_id), Buffer.from(a.task_id)),
    );
    const tasks = yield* Effect.try(() => ordered.map((item) => decodeTask(item.task_json))).pipe(
      Effect.mapError(failed),
    );
    const built = yield* rowsFor(owner, environmentId, viewsByTask, tasks, {});
    return {
      rows: built.rows,
      mainMessageCount: messages,
      ...(built.remoteWork.length === 0 ? {} : { remoteWork: built.remoteWork }),
    };
  });
  // Traced once by list below. Views are read for the page's tasks only.
  const historyPage = Effect.fnUntraced(function* (
    owner: ChannelConnectionOwner,
    botId: BotId,
    environmentId: EnvironmentId,
    cursor: string | undefined,
  ) {
    const page = yield* readHistoryPage(sql, { ownerId: owner.ownerId, botId, cursor });
    const keys = page.tasks.map((task) => TaskViews.taskViewKey(owner.ownerId, task.taskId));
    const viewRows =
      keys.length === 0
        ? []
        : yield* sql<{ readonly key: string; readonly value_json: string }>`SELECT key, value_json
            FROM channel_runtime_state WHERE key IN ${sql.in(keys)}`.pipe(Effect.mapError(failed));
    const viewsByTask = new Map<string, ChannelTaskView>();
    // An unreadable view, or one under another task's key, leaves its row with the empty view and
    // marks the page partial; the current list still fails closed on it.
    let skippedViews = 0;
    for (const row of viewRows) {
      const view = yield* Effect.try(() => decodeView(row.value_json)).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      if (view === undefined || row.key !== TaskViews.taskViewKey(owner.ownerId, view.taskId)) {
        skippedViews += 1;
        continue;
      }
      viewsByTask.set(view.taskId, view);
    }
    const built = yield* rowsFor(owner, environmentId, viewsByTask, page.tasks, {
      threadsOnly: page.threadsOnly,
      launchLimit: CHANNEL_BOT_THREADS_HISTORY_LAUNCHES,
    });
    const partial = page.skippedTasks > 0 || built.skippedLaunches > 0 || skippedViews > 0;
    if (partial)
      yield* Effect.logWarning("GOAT Bot task history left out records it could not read", {
        botId,
        skippedTasks: page.skippedTasks,
        skippedLaunches: built.skippedLaunches,
        skippedViews,
      });
    return {
      rows: built.rows,
      // The bot's count belongs to the current list, which a walk always reads first.
      mainMessageCount: 0,
      ...(built.remoteWork.length === 0 ? {} : { remoteWork: built.remoteWork }),
      history: {
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
        ...(built.launchesTruncated.length === 0
          ? {}
          : { launchesTruncated: built.launchesTruncated }),
        ...(page.endedEarly === true ? { endedEarly: true } : {}),
        ...(partial ? { partial: true } : {}),
      },
    };
  });
  const list = Effect.fn("ChannelBotThreads.list")(function* (
    owner: ChannelConnectionOwner,
    botId: BotId = BotId.make(MAIN_BOT_ID),
    history?: { readonly cursor?: string },
  ) {
    yield* ledger.ensureTaskBotsRepaired().pipe(Effect.mapError(failed));
    // A cursor is checked before anything else, so a missing bot cannot vouch for a foreign one.
    if (history?.cursor !== undefined)
      yield* decodeHistoryCursor({ ownerId: owner.ownerId, botId }, history.cursor);
    const bot = yield* ledger.getBotById(owner.ownerId, botId).pipe(Effect.mapError(failed));
    if (bot === undefined)
      return { rows: [], mainMessageCount: 0, ...(history === undefined ? {} : { history: {} }) };
    return yield* history === undefined
      ? current(owner, botId, bot.bot.environmentId)
      : historyPage(owner, botId, bot.bot.environmentId, history.cursor);
  });
  const listChildWorkFor = Effect.fn("ChannelBotThreads.listChildWork")(function* (
    input: ChannelListChildWorkInput,
    owner: ChannelConnectionOwner,
  ) {
    return yield* listChildWork(ledger, childWork, owner.ownerId, input);
  });
  const getBotTask = Effect.fn("ChannelBotThreads.getBotTask")(function* (
    input: ChannelGetBotTaskInput,
    owner: ChannelConnectionOwner,
  ) {
    yield* ledger.ensureTaskBotsRepaired().pipe(Effect.mapError(failed));
    const rows = yield* sql<{
      readonly task_id: string;
      readonly conversation_id: string;
      readonly task_json: string;
    }>`SELECT t.task_id, t.conversation_id, t.task_json FROM channel_tasks t
      JOIN channel_conversations c ON c.conversation_id = t.conversation_id
      WHERE t.task_id = ${input.taskId} AND t.owner_id = ${owner.ownerId} AND t.bot_id = ${input.botId}
        AND c.owner_id = ${owner.ownerId} AND c.kind = 'goat'`.pipe(Effect.mapError(failed));
    const stored = rows[0];
    if (stored === undefined) return yield* new ChannelGatewayError({ reason: "not_found" });
    const decodedTask = yield* Effect.try(() => decodeTask(stored.task_json)).pipe(
      Effect.mapError(failed),
    );
    if (
      decodedTask.taskId !== stored.task_id ||
      decodedTask.conversationId !== stored.conversation_id
    )
      return yield* new ChannelGatewayError({ reason: "not_found" });
    const task = {
      ...decodedTask,
      taskId: input.taskId,
      conversationId: ChannelConversationId.make(stored.conversation_id),
    };
    const bot = yield* ledger.getBotById(owner.ownerId, input.botId).pipe(Effect.mapError(failed));
    if (bot === undefined) return yield* new ChannelGatewayError({ reason: "not_found" });
    const viewRows = yield* sql<{
      readonly value_json: string;
    }>`SELECT value_json FROM channel_runtime_state WHERE key = ${TaskViews.taskViewKey(owner.ownerId, task.taskId)}`.pipe(
      Effect.mapError(failed),
    );
    const storedView = viewRows[0];
    const view =
      storedView === undefined
        ? { taskId: task.taskId, pinnedAt: null, doneAt: null, readThrough: null }
        : yield* Effect.try(() => decodeView(storedView.value_json)).pipe(
            Effect.orElseSucceed(() => undefined),
          );
    const known = view !== undefined && view.taskId === task.taskId;
    const built = yield* rowsFor(
      owner,
      bot.bot.environmentId,
      known ? new Map([[task.taskId, view]]) : new Map(),
      [task],
      {
        launchLimit: CHANNEL_BOT_THREADS_HISTORY_LAUNCHES,
        unknownView: !known,
      },
    );
    const summary = {
      taskId: task.taskId,
      ...cutBotWorkTitle(task.title),
      status: task.status,
      updatedAt: task.updatedAt,
      ...(task.completedAt === undefined ? {} : { completedAt: task.completedAt }),
      ...(task.generation > 1 ? { generation: task.generation } : {}),
    };
    const worker =
      task.worker === undefined || task.worker.host !== undefined
        ? {}
        : { worker: { environmentId: task.worker.environmentId, threadId: task.worker.threadId } };
    const row = built.rows.find((item) => item.kind === "task");
    if (known && row === undefined) return yield* failed();
    return {
      task:
        known && row?.kind === "task"
          ? { state: "known" as const, row: { ...row, task: summary } }
          : { state: "unavailable" as const, task: summary, ...worker },
      codingRows: built.rows.flatMap((item) =>
        item.kind === "coding"
          ? [{ ...item, ...(item.title === undefined ? {} : cutBotWorkTitle(item.title)) }]
          : [],
      ),
      remoteWork: built.remoteWork,
      launchesTruncated: built.launchesTruncated.length > 0,
      partial: !known || built.skippedLaunches > 0,
    };
  });
  const searchBotTasks = Effect.fn("ChannelBotThreads.searchTasks")(function* (
    input: ChannelSearchBotTasksInput,
    owner: ChannelConnectionOwner,
  ) {
    yield* ledger.ensureTaskBotsRepaired().pipe(Effect.mapError(failed));
    return yield* searchTasks(sql, owner.ownerId, input);
  });
  return ChannelBotThreads.of({
    list,
    update: views.update,
    listChildWork: listChildWorkFor,
    retry,
    getBotTask,
    searchBotTasks,
  });
});
export const layer = Layer.effect(ChannelBotThreads, make);

export const rpcHandlers = (
  service: ChannelBotThreads["Service"],
  owner: ChannelConnectionOwner,
) => ({
  [CHANNEL_GATEWAY_WS_METHODS.listBotThreads]: (input: ChannelListBotThreadsInput) =>
    service.list(owner, input.botId, input.history),
  [CHANNEL_GATEWAY_WS_METHODS.updateTaskView]: (input: ChannelUpdateTaskViewInput) =>
    service.update(input, owner),
  [CHANNEL_GATEWAY_WS_METHODS.listChildWork]: (input: ChannelListChildWorkInput) =>
    service.listChildWork(input, owner),
  [CHANNEL_GATEWAY_WS_METHODS.retryTask]: (input: ChannelRetryTaskInput) =>
    service.retry(input, owner),
  [CHANNEL_GATEWAY_WS_METHODS.getBotTask]: (input: ChannelGetBotTaskInput) =>
    service.getBotTask(input, owner),
  [CHANNEL_GATEWAY_WS_METHODS.searchBotTasks]: (input: ChannelSearchBotTasksInput) =>
    service.searchBotTasks(input, owner),
});
