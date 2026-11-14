import { assert, describe, it } from "@effect/vitest";
import {
  ChannelDeliveryId,
  ChannelInputId,
  ChannelTaskId,
  type ChannelOutboundMessage,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as BotThreads from "./ChannelBotThreads.ts";
import * as ChannelDispatcher from "./ChannelDispatcher.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as Ledger from "./ChannelLedger.ts";
import * as ChannelReceptionService from "./ChannelReceptionService.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import * as Transport from "./ChannelTransport.ts";
import * as Views from "./channelTaskViews.ts";
import { TASK_CHANGES_COALESCE } from "./channelTaskChanges.ts";
import { messageMarkKey } from "./channelTaskMessageMarks.ts";
import { chipDelivery, commitTransition } from "./channelTaskWrites.ts";
import { LedgerCallHolds } from "./testkit/dispatchRace.ts";
import { watchTaskChanges } from "./testkit/taskChanges.ts";
import {
  botThreadId,
  environmentId,
  linkSlackUser,
  makeHarness,
  owner,
  ownerId,
  setupBot,
  slackContext,
  slackInput,
} from "./testkit/ChannelHarness.ts";
import { at, history, insertTask, provide, setup } from "./testkit/botThreadHistory.fixture.ts";

const taskId = ChannelTaskId.make("task:unread");
const otherId = ChannelTaskId.make("task:other");
const destination = { kind: "goat", environmentId, threadId: botThreadId } as const;
const message = (id: string, forTask = taskId): ChannelOutboundMessage => ({
  deliveryId: ChannelDeliveryId.make(id),
  destination,
  kind: "result",
  text: id,
  taskId: forTask,
});
const now = Effect.map(DateTime.now, DateTime.formatIso);
/** Queues messages the way every producer does: through the ledger's outbox insert. */
const queue = (...items: ReadonlyArray<ChannelOutboundMessage>) =>
  Effect.gen(function* () {
    yield* (yield* Ledger.ChannelLedger).enqueueDeliveries(
      items.map((item) => ({
        deliveryId: item.deliveryId,
        causeKey: "test:" + item.deliveryId,
        ...(item.taskId === undefined ? {} : { taskId: item.taskId }),
        message: item,
      })),
      yield* now,
    );
  });
/** A task write one second later, as a status change, a follow-up or a bot step would make. */
const statusUpdate = (id = taskId) =>
  Effect.gen(function* () {
    yield* TestClock.adjust("1 second");
    const ledger = yield* Ledger.ChannelLedger;
    const changed = yield* commitTransition(ledger, (yield* ledger.getTask(id))!, {
      type: "task.worker.bound",
      payload: { worker: { environmentId, threadId: botThreadId, generation: 1 } },
    });
    assert.isDefined(changed);
  });
const followUp = (key: string) =>
  Effect.gen(function* () {
    yield* TestClock.adjust("1 second");
    const ledger = yield* Ledger.ChannelLedger;
    const changed = yield* commitTransition(ledger, (yield* ledger.getTask(taskId))!, {
      type: "task.followup.received",
      payload: { inputId: ChannelInputId.make(key), text: "more", from: "Owner", generation: 1 },
    });
    assert.isDefined(changed);
  });
const rows = Effect.gen(function* () {
  const result = yield* (yield* BotThreads.ChannelBotThreads).list(owner);
  return result.rows.flatMap((item) => (item.kind === "task" ? [item] : []));
});
const row = (id = taskId) =>
  Effect.gen(function* () {
    const found = (yield* rows).find((item) => item.task.taskId === id);
    assert.isDefined(found);
    return found!;
  });
const acknowledge = (readThrough: string) =>
  Effect.gen(function* () {
    yield* (yield* Views.ChannelTaskViews).update({ taskId, readThrough }, owner);
  });
/** A task whose first message the person has read. */
const ready = Effect.gen(function* () {
  yield* setup;
  yield* insertTask(taskId, { status: "running", createdAt: at(1) });
  yield* statusUpdate();
  yield* queue(message("initial"));
  yield* acknowledge((yield* row()).lastActivityAt);
  assert.isFalse((yield* row()).unread);
});
const marks = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ readonly key: string }>`SELECT key FROM channel_runtime_state
    WHERE key LIKE 'task-message-mark:%' ORDER BY key`;
});
const warnings = () => {
  const logs: string[] = [];
  const layer = Logger.layer(
    [
      Logger.make(({ message: logged, logLevel }) => {
        if (logLevel === "Warn") logs.push(JSON.stringify(logged));
      }),
    ],
    { mergeWithExisting: false },
  );
  return { logs, layer };
};

describe("task unread follows messages", () => {
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
    "regression #2550: a bot message turns a read task row unread, and acknowledging its lastActivityAt clears it",
    () =>
      provide(
        Effect.gen(function* () {
          yield* ready;
          yield* statusUpdate();
          yield* queue(message("progress"));
          const current = yield* row();
          assert.isTrue(current.unread);
          yield* acknowledge(current.lastActivityAt);
          assert.isFalse((yield* row()).unread);
        }),
      ),
  );

  it.effect(
    "regression #2550: a bot message committed by narration turns the row unread in the narration's own transaction",
    () =>
      provide(
        Effect.gen(function* () {
          yield* ready;
          const runtime = yield* ChannelRuntime.ChannelRuntime;
          assert.isTrue(yield* runtime.claimForWork);
          const ledger = yield* Ledger.ChannelLedger;
          yield* TestClock.adjust("1 second");
          const changed = yield* commitTransition(
            ledger,
            (yield* ledger.getTask(taskId))!,
            { type: "task.progress", payload: { generation: 1, summary: "Halfway there" } },
            { owner: runtime.ownerToken, narrate: true },
          );
          assert.isDefined(changed);
          const pending = (yield* ledger.listPendingNarrations(10)).find(
            (item) => item.event.taskId === taskId,
          );
          assert.isDefined(pending);
          // Before narration commits there is no message, so the progress write alone stays read.
          assert.isFalse((yield* row()).unread);
          const item = message("narrated");
          yield* ledger.completeNarration({
            owner: runtime.ownerToken,
            sequence: pending!.sequence,
            deliveries: [
              { deliveryId: item.deliveryId, causeKey: "narrated", taskId, message: item },
            ],
            now: yield* now,
          });
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
          yield* insertTask(taskId, { status: "running", createdAt: at(1) });
          yield* acknowledge(at(1));
          yield* statusUpdate();
          // Written by the previous server: the outbox row is there, the mark is not.
          const sql = yield* SqlClient.SqlClient;
          const old = message("before-upgrade");
          yield* sql`INSERT INTO channel_outbox (delivery_id, cause_key, task_id, kind, destination_kind,
            message_json, state, next_attempt_at, created_at, updated_at)
            VALUES ('before-upgrade', 'before-upgrade', ${taskId}, 'result', 'goat',
            ${JSON.stringify(old)}, 'delivered', ${at(0)}, ${at(0)}, ${at(0)})`;
          assert.lengthOf(yield* marks, 0);
          assert.isTrue((yield* row()).unread);
        }),
      ),
  );

  it.effect(
    "contract #2550: when the mark write fails the message is not queued, so it is never shown while its row reads read",
    () =>
      provide(
        Effect.gen(function* () {
          yield* ready;
          const sql = yield* SqlClient.SqlClient;
          yield* sql`CREATE TRIGGER refuse_marks BEFORE INSERT ON channel_runtime_state
            WHEN NEW.key LIKE 'task-message-mark:%'
            BEGIN SELECT RAISE(ABORT, 'mark refused'); END`;
          yield* statusUpdate();
          const refused = yield* Effect.exit(queue(message("refused")));
          assert.isTrue(Exit.isFailure(refused));
          const stored = yield* sql<{ readonly state: string }>`SELECT state FROM channel_outbox
            WHERE delivery_id = 'refused'`;
          assert.lengthOf(stored, 0);
          assert.isFalse((yield* row()).unread);
          yield* sql`DROP TRIGGER refuse_marks`;
          yield* queue(message("refused"));
          assert.isTrue((yield* row()).unread);
        }),
      ),
  );

  it.effect(
    "contract #2550: after a message, a status update moves lastActivityAt and row order exactly as before",
    () =>
      provide(
        Effect.gen(function* () {
          yield* ready;
          yield* insertTask(otherId, { status: "running", createdAt: at(1) });
          yield* statusUpdate(otherId);
          yield* queue(message("progress"));
          yield* statusUpdate();
          const ledger = yield* Ledger.ChannelLedger;
          const updatedAt = (yield* ledger.getTask(taskId))!.task.updatedAt;
          const current = yield* row();
          assert.strictEqual(current.lastActivityAt, updatedAt);
          assert.deepStrictEqual(
            (yield* rows).map((item) => item.task.taskId),
            [taskId, otherId],
          );
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
          yield* queue(message("new"));
          const newer = (yield* row()).lastActivityAt;
          yield* acknowledge(older);
          assert.isTrue((yield* row()).unread);
          yield* acknowledge(newer);
          yield* acknowledge(older);
          assert.isFalse((yield* row()).unread);
          yield* statusUpdate();
          yield* queue(message("newest"));
          yield* acknowledge(newer);
          assert.isTrue((yield* row()).unread);
        }),
      ),
  );

  it.effect(
    "contract #2550: an unreadable mark is reported with its task and the row falls back to the task's last update",
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
        assert.isTrue(
          log.logs.some((entry) => entry.includes("mark unreadable") && entry.includes(taskId)),
        );
        yield* queue(message("repairs"));
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
    "contract #2550: a task chip, an answer decision, a message without a task, another channel and a progress end raise no mark",
    () =>
      provide(
        Effect.gen(function* () {
          yield* setup;
          yield* insertTask(taskId, { status: "running", createdAt: at(1) });
          const ledger = yield* Ledger.ChannelLedger;
          const task = (yield* ledger.getTask(taskId))!;
          const bot = (yield* ledger.getBotById(ownerId, task.botId))!.bot;
          const chip = chipDelivery(task.task, {
            environmentId,
            projectId: bot.projectId,
            threadId: botThreadId,
          });
          const { taskId: _omit, ...withoutTask } = message("no-task");
          yield* queue(
            chip.message,
            { ...message("answer"), personAnswer: { answersQuestionId: null } },
            withoutTask,
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
          const end = { ...message("end"), text: "" };
          yield* ledger.enqueueDeliveries(
            [
              {
                deliveryId: end.deliveryId,
                causeKey: "end",
                taskId,
                message: end,
                operation: "end",
                targetDeliveryId: ChannelDeliveryId.make("initial"),
              },
            ],
            yield* now,
          );
          assert.lengthOf(yield* marks, 0);
        }),
      ),
  );

  it.effect("contract #2550: list and history agree on unread and lastActivityAt", () =>
    provide(
      Effect.gen(function* () {
        yield* ready;
        yield* statusUpdate();
        yield* queue(message("new"));
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

  it.effect(
    "regression #2550: a message with no task write since the read turns the row unread and moves lastActivityAt",
    () =>
      provide(
        Effect.gen(function* () {
          yield* ready;
          const before = (yield* row()).lastActivityAt;
          yield* TestClock.adjust("1 second");
          yield* queue(message("notice"));
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
    "regression #2550: messages in the same millisecond as the read, or after a task clock went backwards, still turn the row unread",
    () =>
      provide(
        Effect.gen(function* () {
          yield* ready;
          yield* queue(message("same-instant"));
          const first = yield* row();
          assert.isTrue(first.unread);
          yield* acknowledge(first.lastActivityAt);
          yield* queue(message("same-instant-again"));
          const second = yield* row();
          assert.isTrue(second.unread);
          yield* acknowledge(second.lastActivityAt);
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE channel_tasks SET updated_at = ${at(30)},
            task_json = json_set(task_json, '$.updatedAt', ${at(30)}) WHERE task_id = ${taskId}`;
          yield* queue(message("after-regression"));
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
          yield* queue(message("lands-first"));
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
          assert.strictEqual(
            (yield* ledger.getTask(taskId))!.task.updatedAt,
            current.lastActivityAt,
          );
        }),
      ),
  );

  it.effect("contract #2550: a task with a new message moves to the top of the list", () =>
    provide(
      Effect.gen(function* () {
        yield* ready;
        yield* insertTask(otherId, { status: "running", createdAt: at(1) });
        yield* statusUpdate(otherId);
        assert.deepStrictEqual(
          (yield* rows).map((item) => item.task.taskId),
          [otherId, taskId],
        );
        yield* queue(message("news"));
        assert.deepStrictEqual(
          (yield* rows).map((item) => item.task.taskId),
          [taskId, otherId],
        );
      }),
    ),
  );

  it.effect("contract #2550: delivering a task message tells open lists to read again", () =>
    provide(
      Effect.gen(function* () {
        yield* ready;
        const seen = yield* watchTaskChanges(owner);
        const transport = Option.getOrThrow(
          yield* (yield* Transport.ChannelTransportRegistry).resolve("goat"),
        );
        yield* transport.send(message("delivered"));
        yield* TestClock.adjust(TASK_CHANGES_COALESCE);
        assert.isTrue(Option.isSome(yield* Queue.poll(seen)));
      }),
    ),
  );

  it.effect(
    "contract #2550: a dispatch step that read the task before a message landed still commits its claim",
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
        yield* queue(message("while-dispatching", id));
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
      }).pipe(Effect.provide(Layer.provideMerge(LedgerCallHolds.layer, harness.layer)));
    },
  );
});
