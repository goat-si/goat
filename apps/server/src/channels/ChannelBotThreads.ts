import {
  BotId,
  CHANNEL_GATEWAY_WS_METHODS,
  ChannelChildWork,
  ChannelChildWorkId,
  ChannelGatewayError,
  ChannelTask,
  ChannelConversationId,
  type BotRemoteWork,
  type BotThreadRow,
  CHANNEL_BOT_THREADS_HISTORY_LAUNCHES,
  CHANNEL_BOT_THREADS_SNOOZED_LIMIT,
  ChannelTaskId,
  type ChannelListBotThreadsInput,
  type ChannelListFollowedThreadsResult,
  type ChannelListBotThreadsResult,
  type ChannelTaskView,
  type ChannelSnoozeBotTaskInput,
  type ChannelUnsnoozeBotTaskInput,
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
  isGoatBotSessionThreadId,
  MAIN_BOT_ID,
  ProjectId,
} from "@goat/contracts";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import type { ChannelConnectionOwner } from "./ChannelIngressContext.ts";
import { makeThreadFollowService } from "./channelThreadFollowService.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelChildWorkStore from "./channelChildWorkStore.ts";
import { listChildWork } from "./listChildWork.ts";
import {
  botRowPullRequests,
  joinRemoteLaunch,
  observedPullRequestSource,
  remoteLaunchPullRequests,
  remotePullRequestColumns,
  threadPullRequestColumns,
  threadPullRequestSource,
  type PullRequestSource,
  type RemotePullRequestColumns,
  type ThreadPullRequestColumns,
} from "./channelBotRowPullRequests.ts";
import {
  botWorkConversationFilter,
  decodeHistoryCursor,
  encodeHistoryCursor,
  launchesStatement,
  quietMessagesStatement,
  readHistoryPage,
} from "./channelBotThreadHistory.ts";
import {
  type HomeTaskRow,
  readHomeSnoozedRevision,
  recentHomeTaskRows,
  snoozedHomeTaskRows,
  unreadableHomeTaskView,
} from "./channelBotHomeTaskRows.ts";
import * as TaskViews from "./channelTaskViews.ts";
import {
  makeMarkWarnings,
  MessageMarkLookup,
  messageMarkKey,
  readMessageMark,
  taskRowUnread,
} from "./channelTaskMessageMarks.ts";
import { makeTaskRetry } from "./channelTaskRetry.ts";
import { cutBotWorkTitle, searchBotTasks as searchTasks } from "./channelBotTaskSearch.ts";

const decodeTask = Schema.decodeUnknownSync(Schema.fromJsonString(ChannelTask));
const decodeView = TaskViews.decodeTaskView;
const decodeChild = Schema.decodeUnknownSync(Schema.fromJsonString(ChannelChildWork));
const isWorkKind = Schema.is(GoatBotWorkKind);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const isGatewayError = Schema.is(ChannelGatewayError);
const failed = () => new ChannelGatewayError({ reason: "persistence_failed" });
const snoozedCursorScope = (owner: Pick<ChannelConnectionOwner, "ownerId">, botId: BotId) => ({
  ownerId: owner.ownerId,
  botId: "snoozed:" + botId,
});
interface ChildRow extends ThreadPullRequestColumns, RemotePullRequestColumns {
  readonly key?: string;
  readonly value_json: string;
  readonly title: string | null;
  readonly project_id: string | null;
  readonly work_kind: unknown;
}

export class ChannelBotThreads extends Context.Service<
  ChannelBotThreads,
  {
    readonly listFollowed: (
      ownerId: string,
      botId: BotId,
    ) => Effect.Effect<ChannelListFollowedThreadsResult["followedThreads"], ChannelGatewayError>;
    readonly update: (
      input: ChannelUpdateTaskViewInput,
      owner: ChannelConnectionOwner,
    ) => Effect.Effect<ChannelTaskView, ChannelGatewayError>;
    readonly snooze: (
      input: ChannelSnoozeBotTaskInput,
      owner: ChannelConnectionOwner,
    ) => Effect.Effect<ChannelTaskView, ChannelGatewayError>;
    readonly unsnooze: (
      input: ChannelUnsnoozeBotTaskInput,
      owner: ChannelConnectionOwner,
    ) => Effect.Effect<ChannelTaskView, ChannelGatewayError>;
    readonly list: (
      owner: ChannelConnectionOwner,
      botId?: BotId,
      history?: { readonly cursor?: string },
      checkSnoozes?: ChannelListBotThreadsInput["checkSnoozes"],
      snoozedAfter?: ChannelListBotThreadsInput["snoozedAfter"],
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
  const follows = yield* makeThreadFollowService(ledger);
  const views = yield* TaskViews.ChannelTaskViews;
  const childWork = yield* ChannelChildWorkStore.ChannelChildWorkStore;
  const retry = yield* makeTaskRetry;
  const warnMark = makeMarkWarnings();
  // Home re-reads the current list often; one unreadable thread warns once.
  const warnPullRequests = makeMarkWarnings("GOAT Bot work row pull request");
  /** Rows for these tasks; history caps each task's launches and lists turns by their threads. */
  const rowsFor = Effect.fn("ChannelBotThreads.rows")(function* (
    owner: Pick<ChannelConnectionOwner, "ownerId">,
    environmentId: EnvironmentId,
    viewsByTask: ReadonlyMap<string, ChannelTaskView>,
    tasks: ReadonlyArray<ChannelTask>,
    options: {
      readonly threadsOnly?: ReadonlySet<string>;
      readonly launchLimit?: number;
      readonly unknownView?: boolean;
      readonly skipLaunches?: boolean;
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
    const markKeys = encodeJson(tasks.map((task) => messageMarkKey(owner.ownerId, task.taskId)));
    // Without marks every row keeps the earlier rule: unread from the task's last update.
    const markRows = yield* (yield* MessageMarkLookup)(markKeys).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.catch((error) =>
        warnMark("lookup:" + owner.ownerId, "channel task message marks unreadable", {
          ownerId: owner.ownerId,
          error,
        }).pipe(Effect.as([])),
      ),
    );
    const marks = new Map(markRows.map((row) => [row.key, row.value_json]));
    const launchLimit = options.launchLimit;
    const listsTask = (task: ChannelTask) =>
      !options.unknownView && !options.threadsOnly?.has(task.taskId);
    // Another machine's worker is not this projection's thread with the same id, and a session
    // thread serves several tasks, so its links belong to none of them.
    const localWorkerThreadId = (task: ChannelTask) =>
      task.worker === undefined ||
      task.worker.host !== undefined ||
      isGoatBotSessionThreadId(task.worker.threadId)
        ? undefined
        : task.worker.threadId;
    const workerIds = [
      ...new Set(
        tasks.flatMap((task) => (listsTask(task) ? (localWorkerThreadId(task) ?? []) : [])),
      ),
    ];
    const workerRows =
      workerIds.length === 0
        ? []
        : yield* sql<{ readonly thread_id: string } & ThreadPullRequestColumns>`SELECT p.thread_id,
            ${threadPullRequestColumns(sql)}
            FROM orchestration_v2_projection_threads p WHERE p.thread_id IN ${sql.in(workerIds)}`.pipe(
            Effect.mapError(failed),
          );
    const workerColumns = new Map(workerRows.map((row) => [row.thread_id, row]));
    // Truncation comes from the raw lookahead, before decoding, so a record that fails to decode
    // cannot hide that a task has more launches than the page lists.
    const truncated = new Set<string>();
    const childRows: ReadonlyArray<ChildRow> = options.skipLaunches
      ? []
      : launchLimit === undefined
        ? yield* sql<ChildRow>`SELECT s.value_json, p.title, p.project_id,
        json_extract(p.payload_json, '$.launchedBy.workKind') AS work_kind, ${threadPullRequestColumns(sql)}, ${remotePullRequestColumns(sql)}
      FROM channel_runtime_state s
      JOIN json_each(${taskIds}) ids
        ON s.key >= ('child-work:' || ids.value || ':') AND s.key < ('child-work:' || ids.value || ';')
      -- Only a local launch's thread is in this machine's projection; a remote one with the same
      -- id is another thread.
      LEFT JOIN orchestration_v2_projection_threads p
        ON json_extract(s.value_json, '$.surface') = 'thread_launch'
        AND json_extract(s.value_json, '$.destination.host') IS NULL
        AND p.thread_id = json_extract(s.value_json, '$.destination.threadId')
      ${joinRemoteLaunch(sql)}
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
      pullRequestColumns: item,
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
    // A thread whose links cannot be read leaves the row to its other sources.
    const unreadablePullRequests: Array<string> = [];
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const readSource = (columns: ThreadPullRequestColumns | undefined, threadId: string) => {
      const source = columns === undefined ? undefined : threadPullRequestSource(columns, nowMs);
      if (source !== "unreadable") return source === undefined ? [] : [source];
      unreadablePullRequests.push(threadId);
      return [];
    };
    for (const task of tasks) {
      if (listsTask(task)) {
        const view = viewsByTask.get(task.taskId) ?? {
          taskId: task.taskId,
          pinnedAt: null,
          doneAt: null,
          readThrough: null,
        };
        const storedMark = marks.get(messageMarkKey(owner.ownerId, task.taskId));
        const mark = storedMark === undefined ? undefined : readMessageMark(storedMark);
        if (storedMark !== undefined && mark === undefined)
          yield* warnMark(
            task.taskId,
            "channel task message mark unreadable; using the last update",
            {
              taskId: task.taskId,
            },
          );
        const workerThreadId = localWorkerThreadId(task);
        const threadSources: Array<PullRequestSource> = [
          ...(workerThreadId === undefined
            ? []
            : readSource(workerColumns.get(workerThreadId), workerThreadId)),
          // The join reads only a local launch's thread.
          ...children.flatMap(({ child, pullRequestColumns }) =>
            child.ownerId === owner.ownerId &&
            child.taskId === task.taskId &&
            child.destination?.threadId !== undefined
              ? readSource(pullRequestColumns, child.destination.threadId)
              : [],
          ),
        ];
        rows.push({
          kind: "task",
          task: {
            taskId: task.taskId,
            title: task.title,
            ...(task.doneMeans === undefined ? {} : { doneMeans: task.doneMeans }),
            status: task.status,
            updatedAt: task.updatedAt,
            ...(task.completedAt === undefined ? {} : { completedAt: task.completedAt }),
            ...(task.generation > 1 ? { generation: task.generation } : {}),
          },
          view,
          lastActivityAt: task.updatedAt,
          unread:
            view.snoozedUntil === undefined &&
            taskRowUnread(task.updatedAt, view.readThrough, mark),
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
          ...botRowPullRequests(threadSources, observedPullRequestSource(task)),
        });
      }
      for (const { child, title, projectId, recordedKind, pullRequestColumns } of children) {
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
            ...remoteLaunchPullRequests(pullRequestColumns),
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
    return {
      rows,
      remoteWork,
      launchesTruncated,
      skippedLaunches,
      unreadablePullRequests,
    };
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
    after: { readonly createdAt: string; readonly taskId: string } | undefined,
  ) {
    const clock = yield* DateTime.now;
    const now = DateTime.toEpochMillis(clock);
    const nowIso = DateTime.formatIso(clock);
    const scope = { ownerId: owner.ownerId, botId, now: nowIso };
    if (
      (yield* unreadableHomeTaskView(sql, owner.ownerId).pipe(Effect.mapError(failed))).length > 0
    )
      return yield* failed();
    const source =
      after === undefined
        ? yield* recentHomeTaskRows(sql, {
            ...scope,
            cutoff: DateTime.formatIso(DateTime.subtractDuration(clock, 3 * 86_400_000)),
          }).pipe(Effect.mapError(failed))
        : [];
    const folded = yield* snoozedHomeTaskRows(sql, scope, after).pipe(Effect.mapError(failed));
    const page = folded.slice(0, CHANNEL_BOT_THREADS_SNOOZED_LIMIT);
    const keys = [...source, ...page].map((row) =>
      TaskViews.taskViewKey(owner.ownerId, ChannelTaskId.make(row.task_id)),
    );
    const stored =
      keys.length === 0
        ? []
        : yield* sql<{
            readonly key: string;
            readonly value_json: string;
          }>`SELECT key, value_json FROM channel_runtime_state WHERE key IN ${sql.in(keys)}`.pipe(
            Effect.mapError(failed),
          );
    const decoded = yield* Effect.try(() => {
      const views = new Map(
        stored.map((row) => {
          const view = decodeView(row.value_json);
          if (row.key !== TaskViews.taskViewKey(owner.ownerId, view.taskId))
            throw new Error("Invalid task view key");
          return [view.taskId, view] as const;
        }),
      );
      const visible = new Map<ChannelTaskId, ChannelTaskView>();
      const decodeRows = (rows: ReadonlyArray<HomeTaskRow>) =>
        rows.map((row) => {
          const task = decodeTask(row.task_json);
          if (task.taskId !== row.task_id) throw new Error("Invalid task key");
          const view = views.get(task.taskId);
          if (view !== undefined)
            visible.set(task.taskId, TaskViews.visibleTaskView(view, row.status_version, now));
          return task;
        });
      const recent = decodeRows(source);
      const suspended = decodeRows(page);
      if (
        page.some((row) => visible.get(ChannelTaskId.make(row.task_id))?.snoozedUntil !== row.until)
      )
        throw new Error("Invalid snoozed task view");
      return { recent, suspended, visible };
    }).pipe(Effect.mapError(failed));
    const built = yield* rowsFor(owner, environmentId, decoded.visible, decoded.recent, {});
    const snoozed = (yield* rowsFor(owner, environmentId, decoded.visible, decoded.suspended, {
      skipLaunches: true,
    })).rows.filter((row): row is Extract<BotThreadRow, { kind: "task" }> => row.kind === "task");
    const nextSnoozeExpiry = after === undefined ? page[0]?.until : undefined;
    const last = page.at(-1);
    const snoozedNextCursor =
      last !== undefined && folded.length > page.length
        ? encodeHistoryCursor(snoozedCursorScope(owner, botId), {
            createdAt: last.until,
            taskId: last.task_id,
          })
        : undefined;
    const snoozedRevision =
      after === undefined && snoozedNextCursor === undefined
        ? undefined
        : yield* readHomeSnoozedRevision(sql, scope).pipe(Effect.mapError(failed));
    const messages = after === undefined ? yield* mainMessageCount(owner, botId) : 0;
    for (const threadId of built.unreadablePullRequests)
      yield* warnPullRequests(
        threadId,
        "GOAT Bot work rows left out a thread's pull requests they could not read",
        { botId, threadId },
      );
    return {
      rows: built.rows,
      ...(snoozed.length === 0 ? {} : { snoozed }),
      ...(snoozedNextCursor === undefined ? {} : { snoozedNextCursor }),
      ...(snoozedRevision === undefined ? {} : { snoozedRevision }),
      ...(nextSnoozeExpiry === undefined ? {} : { nextSnoozeExpiry, readAt: nowIso }),
      mainMessageCount: messages,
      ...(after === undefined
        ? { followedThreads: yield* follows.list(owner.ownerId, botId) }
        : {}),
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
        : yield* sql<{
            readonly key: string;
            readonly value_json: string;
            readonly status_version: number;
          }>`SELECT s.key, s.value_json, t.status_version
            FROM channel_runtime_state s LEFT JOIN channel_tasks t
              ON t.task_id = CASE WHEN json_valid(s.value_json) THEN json_extract(s.value_json, '$.taskId') END
              AND t.owner_id = ${owner.ownerId}
            WHERE s.key IN ${sql.in(keys)}`.pipe(Effect.mapError(failed));
    const viewsByTask = new Map<string, ChannelTaskView>();
    // An unreadable view, or one under another task's key, leaves its row with the empty view and
    // marks the page partial; the current list still fails closed on it.
    let skippedViews = 0;
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    for (const row of viewRows) {
      const view = yield* Effect.try(() => decodeView(row.value_json)).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      if (view === undefined || row.key !== TaskViews.taskViewKey(owner.ownerId, view.taskId)) {
        skippedViews += 1;
        continue;
      }
      viewsByTask.set(view.taskId, TaskViews.visibleTaskView(view, row.status_version, now));
    }
    const built = yield* rowsFor(owner, environmentId, viewsByTask, page.tasks, {
      threadsOnly: page.threadsOnly,
      launchLimit: CHANNEL_BOT_THREADS_HISTORY_LAUNCHES,
    });
    const partial =
      page.skippedTasks > 0 ||
      built.skippedLaunches > 0 ||
      skippedViews > 0 ||
      built.unreadablePullRequests.length > 0;
    if (partial)
      yield* Effect.logWarning("GOAT Bot task history left out records it could not read", {
        botId,
        skippedTasks: page.skippedTasks,
        skippedLaunches: built.skippedLaunches,
        skippedViews,
        skippedPullRequestThreads: built.unreadablePullRequests.length,
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
  const readSnoozes = Effect.fn("ChannelBotThreads.readSnoozes")(function* (
    owner: ChannelConnectionOwner,
    botId: BotId,
    taskIds: NonNullable<ChannelListBotThreadsInput["checkSnoozes"]>,
  ) {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const keys = encodeJson(
      taskIds.map((id) => ({ id, key: TaskViews.taskViewKey(owner.ownerId, id) })),
    );
    const rows = yield* sql<{
      readonly task_id: string;
      readonly value_json: string;
      readonly status_version: number;
    }>`SELECT DISTINCT t.task_id, s.value_json, t.status_version
      FROM json_each(${keys}) k
      JOIN channel_tasks t ON t.task_id = json_extract(k.value, '$.id')
      JOIN channel_runtime_state s ON s.key = json_extract(k.value, '$.key')
      JOIN channel_conversations c ON c.conversation_id = t.conversation_id
      WHERE t.owner_id = ${owner.ownerId} AND t.bot_id = ${botId}
        AND c.owner_id = ${owner.ownerId} AND ${botWorkConversationFilter(sql, botId)}`.pipe(
      Effect.mapError(failed),
    );
    const activeSnoozes = yield* Effect.try(() =>
      rows.flatMap((row) => {
        const view = decodeView(row.value_json);
        if (view.taskId !== row.task_id) throw new Error("Invalid task view key");
        const { taskId, snoozedUntil } = TaskViews.visibleTaskView(view, row.status_version, now);
        return snoozedUntil === undefined ? [] : [{ taskId, until: snoozedUntil }];
      }),
    ).pipe(Effect.mapError(failed));
    return { rows: [], mainMessageCount: 0, activeSnoozes };
  });
  const list = Effect.fn("ChannelBotThreads.list")(function* (
    owner: ChannelConnectionOwner,
    botId: BotId = BotId.make(MAIN_BOT_ID),
    history?: { readonly cursor?: string },
    checkSnoozes?: ChannelListBotThreadsInput["checkSnoozes"],
    snoozedAfter?: ChannelListBotThreadsInput["snoozedAfter"],
  ) {
    if (snoozedAfter !== undefined && (history !== undefined || checkSnoozes !== undefined))
      return yield* new ChannelGatewayError({ reason: "invalid_input" });
    const after =
      snoozedAfter === undefined
        ? undefined
        : yield* decodeHistoryCursor(snoozedCursorScope(owner, botId), snoozedAfter);
    yield* ledger.ensureTaskBotsRepaired().pipe(Effect.mapError(failed));
    if (checkSnoozes !== undefined)
      return yield* readSnoozes(owner, botId, checkSnoozes).pipe(NodeSqliteClient.readOnly);
    // A cursor is checked before anything else, so a missing bot cannot vouch for a foreign one.
    if (history?.cursor !== undefined)
      yield* decodeHistoryCursor({ ownerId: owner.ownerId, botId }, history.cursor);
    const bot = yield* ledger.getBotById(owner.ownerId, botId).pipe(Effect.mapError(failed));
    if (bot === undefined)
      return { rows: [], mainMessageCount: 0, ...(history === undefined ? {} : { history: {} }) };
    return yield* history === undefined
      ? sql.withTransaction(current(owner, botId, bot.bot.environmentId, after)).pipe(
          NodeSqliteClient.readOnly,
          Effect.mapError((error) => (isGatewayError(error) ? error : failed())),
        )
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
    owner: Pick<ChannelConnectionOwner, "ownerId">,
  ) {
    yield* ledger.ensureTaskBotsRepaired().pipe(Effect.mapError(failed));
    const rows = yield* sql<{
      readonly task_id: string;
      readonly conversation_id: string;
      readonly status_version: number;
      readonly task_json: string;
    }>`SELECT t.task_id, t.conversation_id, t.task_json, t.status_version FROM channel_tasks t
      JOIN channel_conversations c ON c.conversation_id = t.conversation_id
      WHERE t.task_id = ${input.taskId} AND t.owner_id = ${owner.ownerId} AND t.bot_id = ${input.botId}
        AND c.owner_id = ${owner.ownerId} AND ${botWorkConversationFilter(sql, input.botId)}`.pipe(
      Effect.mapError(failed),
    );
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
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const built = yield* rowsFor(
      owner,
      bot.bot.environmentId,
      known
        ? new Map([[task.taskId, TaskViews.visibleTaskView(view, stored.status_version, now)]])
        : new Map(),
      [task],
      {
        launchLimit: CHANNEL_BOT_THREADS_HISTORY_LAUNCHES,
        unknownView: !known,
      },
    );
    const summary = {
      taskId: task.taskId,
      ...cutBotWorkTitle(task.title),
      ...(task.doneMeans === undefined ? {} : { doneMeans: task.doneMeans }),
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
    const assigned = task.worker;
    const remotePrimary =
      assigned?.host === undefined
        ? []
        : [
            {
              childWorkId: ChannelChildWorkId.make(
                "assigned:" + task.taskId + ":" + task.generation,
              ),
              taskId: task.taskId,
              callerThreadId: bot.bot.threadId,
              host: assigned.host,
              environmentId: assigned.environmentId,
              threadId: assigned.threadId,
              state:
                task.status === "completed" ||
                task.status === "failed" ||
                task.status === "cancelled"
                  ? task.status
                  : ("bound" as const),
              lastActivityAt: task.updatedAt,
              ...botRowPullRequests([], observedPullRequestSource(task)),
            },
          ];
    const activity = yield* ledger.readTaskActivity({
      task,
      ownerId: owner.ownerId,
      environmentId: bot.bot.environmentId,
    });
    return {
      activity,
      task:
        known && row?.kind === "task"
          ? { state: "known" as const, row: { ...row, task: summary } }
          : { state: "unavailable" as const, task: summary, ...worker },
      codingRows: built.rows.flatMap((item) =>
        item.kind === "coding"
          ? [{ ...item, ...(item.title === undefined ? {} : cutBotWorkTitle(item.title)) }]
          : [],
      ),
      remoteWork: [...remotePrimary, ...built.remoteWork],
      launchesTruncated: built.launchesTruncated.length > 0,
      partial: !known || built.skippedLaunches > 0 || built.unreadablePullRequests.length > 0,
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
    listFollowed: Effect.fn("ChannelBotThreads.listFollowed")((ownerId, botId) =>
      follows.list(ownerId, botId).pipe(Effect.mapError(failed)),
    ),
    update: views.update,
    snooze: views.snooze,
    unsnooze: views.snooze,
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
    service.list(owner, input.botId, input.history, input.checkSnoozes, input.snoozedAfter),
  [CHANNEL_GATEWAY_WS_METHODS.updateTaskView]: (input: ChannelUpdateTaskViewInput) =>
    service.update(input, owner),
  [CHANNEL_GATEWAY_WS_METHODS.listChildWork]: (input: ChannelListChildWorkInput) =>
    service.listChildWork(input, owner),
  [CHANNEL_GATEWAY_WS_METHODS.retryTask]: (input: ChannelRetryTaskInput) =>
    service.retry(input, owner),
  [CHANNEL_GATEWAY_WS_METHODS.snoozeBotTask]: (input: ChannelSnoozeBotTaskInput) =>
    service.snooze(input, owner),
  [CHANNEL_GATEWAY_WS_METHODS.unsnoozeBotTask]: (input: ChannelUnsnoozeBotTaskInput) =>
    service.unsnooze(input, owner),
  [CHANNEL_GATEWAY_WS_METHODS.getBotTask]: (input: ChannelGetBotTaskInput) =>
    service.getBotTask(input, owner),
  [CHANNEL_GATEWAY_WS_METHODS.searchBotTasks]: (input: ChannelSearchBotTasksInput) =>
    service.searchBotTasks(input, owner),
});
