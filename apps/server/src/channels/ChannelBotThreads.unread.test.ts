import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import { classifySqliteError, SqlError } from "effect/sql/SqlError";
import * as TestClock from "effect/testing/TestClock";
import * as BotThreads from "./ChannelBotThreads.ts";
import * as ChannelDispatcher from "./ChannelDispatcher.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as Ledger from "./ChannelLedger.ts";
import * as ChannelReceptionService from "./ChannelReceptionService.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import * as Views from "./channelTaskViews.ts";
import { TASK_CHANGES_COALESCE } from "./channelTaskChanges.ts";
import {
  makeMarkWarnings,
  MARK_WARNINGS_REMEMBERED,
  MessageMarkLookup,
  messageMarkKey,
} from "./channelTaskMessageMarks.ts";
import { chipDelivery, commitTransition } from "./channelTaskWrites.ts";
import { LedgerCallHolds } from "./testkit/dispatchRace.ts";
import { watchTaskChanges } from "./testkit/taskChanges.ts";
import {
  botThreadId,
  environmentId,
  goatInput,
  linkSlackUser,
  makeHarness,
  owner,
  ownerId,
  rpcContext,
  setupBot,
  slackContext,
  slackInput,
} from "./testkit/ChannelHarness.ts";
import { at, history, provide, setup } from "./testkit/botThreadHistory.fixture.ts";

import {
  taskId,
  otherId,
  message,
  now,
  task,
  queue,
  ownerToken,
  deliverDue,
  deliver,
  statusUpdate,
  followUp,
  rows,
  row,
  acknowledge,
  ready,
  markOf,
  outboxState,
  updatedAt,
  warnings,
} from "./testkit/botThreadUnread.fixture.ts";

describe("task unread follows delivered messages", () => {
  it.effect(
    "regression #2550: a status update or the person's follow-up does not turn a read task row unread",
    () =>
      provide(
        Effect.gen(function* () {
          yield* ready;
          yield* statusUpdate();
          assert.isFalse((yield* row()).unread);
          yield* followUp("follow-up");
          assert.isFalse((yield* row()).unread);
        }),
      ),
  );

  it.effect(
    "regression #2550: a queued message changes nothing until it is delivered; delivery turns the row unread and announces once",
    () =>
      provide(
        Effect.gen(function* () {
          yield* ready;
          const before = yield* row();
          const seen = yield* watchTaskChanges(owner);
          yield* TestClock.adjust("1 second");
          yield* queue(message("pending"));
          const pending = yield* row();
          assert.isFalse(pending.unread);
          assert.strictEqual(pending.lastActivityAt, before.lastActivityAt);
          yield* TestClock.adjust(TASK_CHANGES_COALESCE);
          assert.isTrue(Option.isNone(yield* Queue.poll(seen)));
          yield* deliverDue;
          assert.strictEqual(yield* outboxState("pending"), "delivered");
          const delivered = yield* row();
          assert.isTrue(delivered.unread);
          assert.isAbove(Date.parse(delivered.lastActivityAt), Date.parse(before.lastActivityAt));
          yield* TestClock.adjust(TASK_CHANGES_COALESCE);
          assert.isTrue(Option.isSome(yield* Queue.poll(seen)));
          yield* TestClock.adjust(TASK_CHANGES_COALESCE);
          assert.isTrue(Option.isNone(yield* Queue.poll(seen)));
          yield* acknowledge(delivered.lastActivityAt);
          assert.isFalse((yield* row()).unread);
        }),
      ),
  );

  it.effect(
    "regression #2550: a message queued, then acknowledged over, then delivered is unread",
    () =>
      provide(
        Effect.gen(function* () {
          yield* ready;
          yield* TestClock.adjust("1 second");
          yield* queue(message("late"));
          yield* acknowledge((yield* row()).lastActivityAt);
          yield* deliverDue;
          assert.isTrue((yield* row()).unread);
        }),
      ),
  );

  it.effect(
    "regression #2550: a bot message committed by narration turns the row unread once it is delivered",
    () =>
      provide(
        Effect.gen(function* () {
          yield* ready;
          const ledger = yield* Ledger.ChannelLedger;
          const token = yield* ownerToken;
          yield* TestClock.adjust("1 second");
          const changed = yield* commitTransition(
            ledger,
            (yield* ledger.getTask(taskId))!,
            { type: "task.progress", payload: { generation: 1, summary: "Halfway there" } },
            { owner: token, narrate: true },
          );
          assert.isDefined(changed);
          const pending = (yield* ledger.listPendingNarrations(10)).find(
            (item) => item.event.taskId === taskId,
          );
          assert.isDefined(pending);
          assert.isFalse((yield* row()).unread);
          const item = message("narrated");
          yield* ledger.completeNarration({
            owner: token,
            sequence: pending!.sequence,
            deliveries: [
              { deliveryId: item.deliveryId, causeKey: "narrated", taskId, message: item },
            ],
            now: yield* now,
          });
          assert.isFalse((yield* row()).unread);
          yield* deliverDue;
          assert.isTrue((yield* row()).unread);
        }),
      ),
  );

  it.effect(
    "contract #2550: on the first list after upgrading, a task with an unseen message from before the upgrade is unread",
    () =>
      provide(
        Effect.gen(function* () {
          yield* setup;
          yield* task(taskId);
          yield* acknowledge(at(1));
          yield* statusUpdate();
          // Written by the previous server: the outbox row is there, the mark is not.
          const sql = yield* SqlClient.SqlClient;
          const old = message("before-upgrade");
          yield* sql`INSERT INTO channel_outbox (delivery_id, cause_key, task_id, kind, destination_kind,
            message_json, state, next_attempt_at, created_at, updated_at)
            VALUES ('before-upgrade', 'before-upgrade', ${taskId}, 'result', 'goat',
            ${JSON.stringify(old)}, 'delivered', ${at(0)}, ${at(0)}, ${at(0)})`;
          assert.lengthOf(yield* markOf, 0);
          assert.isTrue((yield* row()).unread);
        }),
      ),
  );

  it.effect(
    "regression #2550: a delivered message with no task write since the read turns the row unread and moves lastActivityAt",
    () =>
      provide(
        Effect.gen(function* () {
          yield* ready;
          const before = (yield* row()).lastActivityAt;
          yield* TestClock.adjust("1 second");
          yield* deliver(message("notice"));
          const current = yield* row();
          assert.isTrue(current.unread);
          assert.isAbove(Date.parse(current.lastActivityAt), Date.parse(before));
          yield* acknowledge(before);
          assert.isTrue((yield* row()).unread);
          yield* acknowledge(current.lastActivityAt);
          assert.isFalse((yield* row()).unread);
        }),
      ),
  );

  it.effect(
    "regression #2550: messages delivered in the same millisecond as the read, or after a task clock went backwards, still turn the row unread",
    () =>
      provide(
        Effect.gen(function* () {
          yield* ready;
          yield* deliver(message("same-instant"));
          const first = yield* row();
          assert.isTrue(first.unread);
          yield* acknowledge(first.lastActivityAt);
          yield* deliver(message("same-instant-again"));
          const second = yield* row();
          assert.isTrue(second.unread);
          yield* acknowledge(second.lastActivityAt);
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE channel_tasks SET updated_at = ${at(30)},
            task_json = json_set(task_json, '$.updatedAt', ${at(30)}) WHERE task_id = ${taskId}`;
          yield* deliver(message("after-regression"));
          assert.isTrue((yield* row()).unread);
        }),
      ),
  );

  it.effect(
    "regression #2550: a task write prepared before a message, with an equal or earlier clock, cannot make that message read",
    () =>
      provide(
        Effect.gen(function* () {
          yield* ready;
          const ledger = yield* Ledger.ChannelLedger;
          const prepared = (yield* ledger.getTask(taskId))!;
          yield* deliver(message("lands-first"));
          const after = yield* row();
          assert.isTrue(after.unread);
          // Same version, so the write commits; its clock is behind the message's activity.
          const changed = yield* commitTransition(ledger, prepared, {
            type: "task.progress",
            payload: { generation: 1, summary: "Still working" },
          });
          assert.isDefined(changed);
          const current = yield* row();
          assert.isTrue(current.unread);
          assert.isAtLeast(Date.parse(current.lastActivityAt), Date.parse(after.lastActivityAt));
          assert.strictEqual(yield* updatedAt(), current.lastActivityAt);
        }),
      ),
  );

  it.effect(
    "regression #2550: an acknowledgement in flight from before a message does not clear it, and acknowledgements out of order keep the newest",
    () =>
      provide(
        Effect.gen(function* () {
          yield* ready;
          const older = (yield* row()).lastActivityAt;
          yield* statusUpdate();
          yield* deliver(message("new"));
          const newer = (yield* row()).lastActivityAt;
          yield* acknowledge(older);
          assert.isTrue((yield* row()).unread);
          yield* acknowledge(newer);
          yield* acknowledge(older);
          assert.isFalse((yield* row()).unread);
          yield* statusUpdate();
          yield* deliver(message("newest"));
          yield* acknowledge(newer);
          assert.isTrue((yield* row()).unread);
        }),
      ),
  );

  it.effect(
    "contract #2550: a task with a delivered message moves to the top of the list, and a later status update moves lastActivityAt as before",
    () =>
      provide(
        Effect.gen(function* () {
          yield* ready;
          yield* task(otherId);
          yield* statusUpdate(otherId);
          assert.deepStrictEqual(
            (yield* rows).map((item) => item.task.taskId),
            [otherId, taskId],
          );
          yield* deliver(message("news"));
          assert.deepStrictEqual(
            (yield* rows).map((item) => item.task.taskId),
            [taskId, otherId],
          );
          yield* statusUpdate();
          assert.strictEqual((yield* row()).lastActivityAt, yield* updatedAt());
        }),
      ),
  );

  it.effect(
    "contract #2550: a dispatch step that read the task before a message was delivered still commits its claim",
    () => {
      const harness = makeHarness({
        projects: 1,
        providerInstances: [
          { instanceId: "codex", displayName: "Local Codex", weeklyUsedPercent: 80 },
        ],
      });
      return Effect.gen(function* () {
        yield* setupBot;
        yield* linkSlackUser();
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        assert.isTrue(yield* runtime.claimForWork);
        const input = yield* (yield* ChannelGateway.ChannelGateway).ingest(
          slackInput("do: inspect the build", "message-race"),
          slackContext,
        );
        yield* (yield* ChannelReceptionService.ChannelReceptionService).receive(
          input.inputId,
          runtime.ownerToken,
        );
        const ledger = yield* Ledger.ChannelLedger;
        const [received] = yield* ledger.listTasksByStatus(["received"]);
        assert.isDefined(received);
        const id = received!.task.taskId;
        const hold = yield* (yield* LedgerCallHolds).holdNext(
          "getRemoteWorker",
          (held) => held === id,
        );
        const dispatch = yield* Effect.forkChild(
          (yield* ChannelDispatcher.ChannelDispatcher).dispatch(id, runtime.ownerToken),
        );
        yield* hold.reached;
        yield* TestClock.adjust("1 second");
        yield* deliver(message("while-dispatching", id));
        assert.strictEqual(yield* outboxState("while-dispatching"), "delivered");
        const bumped = (yield* ledger.getTask(id))!.task;
        assert.strictEqual(bumped.version, received!.task.version);
        assert.isAbove(Date.parse(bumped.updatedAt), Date.parse(received!.task.updatedAt));
        yield* hold.release;
        yield* Fiber.join(dispatch);
        const sql = yield* SqlClient.SqlClient;
        const claims = yield* sql`SELECT type FROM channel_task_events
          WHERE task_id = ${id} AND type = 'task.dispatch.claimed'`;
        assert.lengthOf(claims, 1);
        assert.lengthOf(harness.world.launches, 1);
        assert.isAtLeast(Date.parse(yield* updatedAt(id)), Date.parse(bumped.updatedAt));
      }).pipe(Effect.provide(Layer.provideMerge(LedgerCallHolds.layer, harness.layer)));
    },
  );

  it.effect(
    "contract #2550: a task chip, an answer decision, a message without a task and another channel raise no mark",
    () =>
      provide(
        Effect.gen(function* () {
          yield* setup;
          yield* task(taskId);
          const before = yield* updatedAt();
          const ledger = yield* Ledger.ChannelLedger;
          const stored = (yield* ledger.getTask(taskId))!;
          const bot = (yield* ledger.getBotById(ownerId, stored.botId))!.bot;
          const chip = chipDelivery(stored.task, {
            environmentId,
            projectId: bot.projectId,
            threadId: botThreadId,
          });
          yield* (yield* ChannelGateway.ChannelGateway).ingest(
            goatInput("hello", "main-input"),
            rpcContext,
          );
          const input = (yield* ledger.listPendingInputs(10))[0];
          assert.isDefined(input);
          const { taskId: _omit, ...withoutTask } = message("no-task");
          yield* deliver(
            chip.message,
            {
              ...message("answer"),
              inReplyToInputId: input!,
              personAnswer: { answersQuestionId: null },
            },
            { ...withoutTask, inReplyToInputId: input! },
            {
              ...message("slack"),
              destination: {
                kind: "slack",
                connectionId: "slack",
                teamId: "team",
                channelId: "channel",
                rootTs: "1",
              },
            },
          );
          assert.strictEqual(yield* outboxState("no-task"), "delivered");
          assert.lengthOf(yield* markOf, 0);
          assert.strictEqual(yield* updatedAt(), before);
        }),
      ),
  );

  it.effect(
    "contract #2550: an unreadable mark is reported once with its task, and the row falls back to the task's last update",
    () => {
      const log = warnings();
      return Effect.gen(function* () {
        yield* ready;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE channel_runtime_state SET value_json = 'not json'
          WHERE key = ${messageMarkKey(ownerId, taskId)}`;
        assert.isFalse((yield* row()).unread);
        yield* statusUpdate();
        assert.isTrue((yield* row()).unread);
        const reported = log.logs.filter(
          (entry) => entry.includes("mark unreadable") && entry.includes(taskId),
        );
        assert.lengthOf(reported, 1);
        yield* deliver(message("repairs"));
        const repaired = yield* row();
        assert.isTrue(repaired.unread);
        yield* acknowledge(repaired.lastActivityAt);
        yield* statusUpdate();
        assert.isFalse((yield* row()).unread);
      }).pipe(
        Effect.provide(
          Layer.merge(
            BotThreads.layer.pipe(
              Layer.provideMerge(Views.layer),
              Layer.provideMerge(makeHarness().layer),
            ),
            log.layer,
          ),
        ),
      );
    },
  );

  it.effect(
    "contract #2550: when the mark lookup fails, list and history still return rows by the task's last update, warning once",
    () => {
      const log = warnings();
      return Effect.gen(function* () {
        yield* ready;
        yield* statusUpdate();
        assert.isTrue((yield* row()).unread);
        const fromHistory = (yield* history()).rows.find(
          (item) => item.kind === "task" && item.task.taskId === taskId,
        );
        assert.strictEqual(fromHistory?.kind === "task" && fromHistory.unread, true);
        const reported = log.logs.filter((entry) => entry.includes("marks unreadable"));
        assert.lengthOf(reported, 1);
      }).pipe(
        Effect.provideService(MessageMarkLookup, () =>
          Effect.fail(
            new SqlError({
              reason: classifySqliteError(new Error("database disk image is malformed")),
            }),
          ),
        ),
        Effect.provide(
          Layer.merge(
            BotThreads.layer.pipe(
              Layer.provideMerge(Views.layer),
              Layer.provideMerge(makeHarness().layer),
            ),
            log.layer,
          ),
        ),
      );
    },
  );

  it.effect(
    "contract #2550: mark warnings remember a bounded number of keys, then say so once and stop",
    () => {
      const log = warnings();
      return Effect.gen(function* () {
        const warn = makeMarkWarnings();
        for (let index = 0; index <= MARK_WARNINGS_REMEMBERED; index++)
          yield* warn("task-" + index, "channel task message mark unreadable", { index });
        yield* warn("task-0", "channel task message mark unreadable", { index: 0 });
        yield* warn("task-new", "channel task message mark unreadable", { index: -1 });
        assert.lengthOf(log.logs, MARK_WARNINGS_REMEMBERED + 1);
        assert.include(log.logs.at(-1), "stop here");
      }).pipe(Effect.provide(log.layer));
    },
  );

  it.effect(
    "contract #2550: keeping the later updated_at orders ISO times 1 ms apart, and every task time the ledger writes has one format",
    () =>
      provide(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const earlier = "2026-11-14T00:00:00.000Z";
          const later = "2026-11-14T00:00:00.001Z";
          for (const [stored, written] of [
            [earlier, later],
            [later, earlier],
          ]) {
            const [kept] = yield* sql<{ readonly kept: string }>`SELECT CASE
              WHEN julianday(${stored}) > julianday(${written}) THEN ${stored} ELSE ${written} END AS kept`;
            assert.strictEqual(kept?.kept, later);
          }
          yield* ready;
          yield* deliver(message("formatted"));
          yield* statusUpdate();
          const times = yield* sql<{ readonly column: string; readonly snapshot: string }>`SELECT
            updated_at AS column, json_extract(task_json, '$.updatedAt') AS snapshot FROM channel_tasks`;
          assert.isNotEmpty(times);
          for (const time of times) {
            assert.match(time.column, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
            assert.strictEqual(time.snapshot, time.column);
          }
        }),
      ),
  );

  it.effect("contract #2550: list and history agree on unread and lastActivityAt", () =>
    provide(
      Effect.gen(function* () {
        yield* ready;
        yield* statusUpdate();
        yield* deliver(message("new"));
        const current = yield* row();
        const fromHistory = (yield* history()).rows.find(
          (item) => item.kind === "task" && item.task.taskId === taskId,
        );
        assert.isTrue(current.unread);
        assert.strictEqual(fromHistory?.kind === "task" && fromHistory.unread, true);
        assert.strictEqual(
          fromHistory?.kind === "task" && fromHistory.lastActivityAt,
          current.lastActivityAt,
        );
      }),
    ),
  );
});
