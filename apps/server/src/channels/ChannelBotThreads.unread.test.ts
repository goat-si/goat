import { assert, describe, it } from "@effect/vitest";
import {
  ChannelDeliveryId,
  ChannelInputId,
  ChannelTaskId,
  type ChannelOutboundMessage,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as BotThreads from "./ChannelBotThreads.ts";
import * as Ledger from "./ChannelLedger.ts";
import * as Gateway from "./ChannelGateway.ts";
import * as Transport from "./ChannelTransport.ts";
import * as Views from "./channelTaskViews.ts";
import { chipDelivery, commitTransition } from "./channelTaskWrites.ts";
import {
  botThreadId,
  environmentId,
  goatInput,
  makeHarness,
  owner,
  ownerId,
  rpcContext,
} from "./testkit/ChannelHarness.ts";
import { at, history, insertTask, provide, setup } from "./testkit/botThreadHistory.fixture.ts";
import { LedgerCallHolds } from "./testkit/dispatchRace.ts";

const taskId = ChannelTaskId.make("task:unread");
const destination = { kind: "goat", environmentId, threadId: botThreadId } as const;
const message = (id: string): ChannelOutboundMessage => ({
  deliveryId: ChannelDeliveryId.make(id),
  destination,
  kind: "result",
  text: id,
  taskId,
});
const send = (item: ChannelOutboundMessage) =>
  Effect.gen(function* () {
    const registry = yield* Transport.ChannelTransportRegistry;
    const transport = Option.getOrThrow(yield* registry.resolve("goat"));
    yield* transport.send(item);
  });
const row = Effect.gen(function* () {
  const result = yield* (yield* BotThreads.ChannelBotThreads).list(owner);
  const found = result.rows.find((item) => item.kind === "task" && item.task.taskId === taskId);
  assert.isDefined(found);
  if (found?.kind !== "task") throw new Error("missing task row");
  return found;
});
const acknowledge = Effect.gen(function* () {
  const current = yield* row;
  yield* (yield* Views.ChannelTaskViews).update(
    { taskId, readThrough: current.lastActivityAt },
    owner,
  );
  return current;
});
const ready = Effect.gen(function* () {
  yield* setup;
  yield* insertTask(taskId, { status: "running", createdAt: at(1) });
  yield* send(message("initial"));
  yield* acknowledge;
});

describe("task unread follows delivered messages", () => {
  it.effect(
    "regression #2550: the person's own follow-up does not mark a read task row unread",
    () =>
      provide(
        Effect.gen(function* () {
          yield* ready;
          yield* TestClock.adjust("1 second");
          const ledger = yield* Ledger.ChannelLedger;
          const changed = yield* commitTransition(ledger, (yield* ledger.getTask(taskId))!, {
            type: "task.followup.received",
            payload: {
              inputId: ChannelInputId.make("followup"),
              text: "more",
              from: "Owner",
              generation: 1,
            },
          });
          assert.isDefined(changed);
          assert.isFalse((yield* row).unread);
        }),
      ),
  );
  it.effect(
    "regression #2550: a status write with nothing to read does not mark a read task row unread",
    () =>
      provide(
        Effect.gen(function* () {
          yield* ready;
          yield* TestClock.adjust("1 second");
          const ledger = yield* Ledger.ChannelLedger;
          const changed = yield* commitTransition(ledger, (yield* ledger.getTask(taskId))!, {
            type: "task.worker.bound",
            payload: { worker: { environmentId, threadId: botThreadId, generation: 1 } },
          });
          assert.isDefined(changed);
          assert.isFalse((yield* row).unread);
        }),
      ),
  );
  it.effect(
    "regression #2550: a message delivered after the row was acknowledged marks it unread at the same instant, and acknowledging lastActivityAt clears it",
    () =>
      provide(
        Effect.gen(function* () {
          yield* ready;
          yield* send(message("new"));
          assert.isTrue((yield* row).unread);
          yield* acknowledge;
          assert.isFalse((yield* row).unread);
        }),
      ),
  );
  it.effect(
    "regression #2550: a delayed acknowledgement of an older row does not clear a message delivered after it",
    () =>
      provide(
        Effect.gen(function* () {
          yield* ready;
          const older = yield* row;
          yield* send(message("new"));
          yield* (yield* Views.ChannelTaskViews).update(
            { taskId, readThrough: older.lastActivityAt },
            owner,
          );
          assert.isTrue((yield* row).unread);
        }),
      ),
  );
  it.effect(
    "regression #2550: a delayed acknowledgement of a row shown before its first message does not clear that message",
    () =>
      provide(
        Effect.gen(function* () {
          yield* setup;
          yield* insertTask(taskId, { status: "running", createdAt: at(0) });
          const shown = yield* row;
          assert.isFalse(shown.unread);
          yield* send(message("first"));
          yield* (yield* Views.ChannelTaskViews).update(
            { taskId, readThrough: shown.lastActivityAt },
            owner,
          );
          assert.isTrue((yield* row).unread);
        }),
      ),
  );
  it.effect(
    "regression #2550: retrying a delivery after more than sixteen later ones leaves the read row read",
    () =>
      provide(
        Effect.gen(function* () {
          yield* ready;
          const old = message("old");
          yield* (yield* Ledger.ChannelLedger).enqueueDeliveries(
            [{ deliveryId: old.deliveryId, causeKey: "old", taskId, message: old }],
            at(0),
          );
          // Recorded and marked, but its outbox row stays pending, as after a crash before delivered.
          yield* send(old);
          for (let index = 0; index < 17; index++) yield* send(message("later-" + index));
          yield* acknowledge;
          yield* send(old);
          assert.isFalse((yield* row).unread);
        }),
      ),
  );

  it.effect(
    "regression #2550: a task write between the transport's task read and its first mark cannot let the row's acknowledgement clear that message",
    () =>
      Effect.gen(function* () {
        yield* setup;
        yield* insertTask(taskId, { status: "running", createdAt: at(0) });
        const ledger = yield* Ledger.ChannelLedger;
        // The transport reads the task twice (its source, then its owner); hold after the second read.
        let reads = 0;
        const hold = yield* (yield* LedgerCallHolds).holdAfterNext(
          "getTask",
          (id) => id === taskId && ++reads === 2,
        );
        const delivery = yield* Effect.forkChild(send(message("first")));
        yield* hold.reached;
        // The transport has read the task; a later write moves updatedAt before the mark is raised.
        yield* TestClock.adjust("1 second");
        const changed = yield* commitTransition(ledger, (yield* ledger.getTask(taskId))!, {
          type: "task.followup.received",
          payload: {
            inputId: ChannelInputId.make("between"),
            text: "more",
            from: "Owner",
            generation: 1,
          },
        });
        assert.isDefined(changed);
        const shown = yield* row;
        yield* hold.release;
        yield* Fiber.join(delivery);
        yield* (yield* Views.ChannelTaskViews).update(
          { taskId, readThrough: shown.lastActivityAt },
          owner,
        );
        assert.isTrue((yield* row).unread);
      }).pipe(
        Effect.provide(
          BotThreads.layer.pipe(
            Layer.provideMerge(Views.layer),
            Layer.provideMerge(Layer.provideMerge(LedgerCallHolds.layer, makeHarness().layer)),
          ),
        ),
      ),
  );

  it.effect(
    "contract #2550: resending the same delivery after it was read leaves the row read",
    () =>
      provide(
        Effect.gen(function* () {
          yield* ready;
          yield* send(message("new"));
          yield* acknowledge;
          yield* send(message("new"));
          assert.isFalse((yield* row).unread);
        }),
      ),
  );
  it.effect(
    "regression #2550: a message queued but not yet delivered does not mark a read row unread until the GOAT transport records it",
    () =>
      provide(
        Effect.gen(function* () {
          yield* ready;
          const item = message("queued");
          yield* (yield* Ledger.ChannelLedger).enqueueDeliveries(
            [{ deliveryId: item.deliveryId, causeKey: "queued", taskId, message: item }],
            at(0),
          );
          assert.isFalse((yield* row).unread);
          yield* send(item);
          assert.isTrue((yield* row).unread);
        }),
      ),
  );
  it.effect(
    "contract #2550: a task chip, a non-GOAT delivery and a delivery without a task leave the row read; a delivery for another owner's task raises nothing",
    () =>
      provide(
        Effect.gen(function* () {
          yield* ready;
          const ledger = yield* Ledger.ChannelLedger;
          const task = (yield* ledger.getTask(taskId))!.task;
          yield* send(
            chipDelivery(task, {
              environmentId,
              projectId: (yield* ledger.getBotById(
                ownerId,
                (yield* ledger.getTask(taskId))!.botId,
              ))!.bot.projectId,
              threadId: botThreadId,
            }).message,
          );
          const slack = Option.getOrThrow(
            yield* (yield* Transport.ChannelTransportRegistry).resolve("slack"),
          );
          yield* slack.send({
            ...message("slack"),
            destination: {
              kind: "slack",
              connectionId: "slack",
              teamId: "team",
              channelId: "channel",
              rootTs: "1",
            },
          });
          yield* (yield* Gateway.ChannelGateway).ingest(
            goatInput("hello", "main-input"),
            rpcContext,
          );
          const input = (yield* ledger.listPendingInputs(10))[0];
          assert.isDefined(input);
          const { taskId: _taskId, ...withoutTask } = message("no-task");
          yield* send({ ...withoutTask, inReplyToInputId: input! });
          yield* send({
            ...message("answer"),
            inReplyToInputId: input!,
            personAnswer: { answersQuestionId: null },
          });
          yield* send({
            ...message("missing"),
            inReplyToInputId: input!,
            taskId: ChannelTaskId.make("task:missing"),
          });
          yield* insertTask("task:foreign", { status: "running", createdAt: at(1) });
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE channel_tasks SET owner_id = 'foreign' WHERE task_id = 'task:foreign'`;
          yield* send({ ...message("foreign"), taskId: ChannelTaskId.make("task:foreign") });
          const wrongKey =
            "task-message-mark:" +
            encodeURIComponent(ownerId) +
            ":" +
            encodeURIComponent("task:foreign");
          const wrongMarks =
            yield* sql`SELECT key FROM channel_runtime_state WHERE key = ${wrongKey}`;
          assert.lengthOf(wrongMarks, 0);
          const missingKey =
            "task-message-mark:" +
            encodeURIComponent(ownerId) +
            ":" +
            encodeURIComponent("task:missing");
          assert.lengthOf(
            yield* sql`SELECT key FROM channel_runtime_state WHERE key = ${missingKey}`,
            0,
          );
          assert.isFalse((yield* row).unread);
        }),
      ),
  );
  it.effect("contract #2550: list and history agree on unread and lastActivityAt", () =>
    provide(
      Effect.gen(function* () {
        yield* ready;
        yield* send(message("new"));
        const current = yield* row;
        const fromHistory = (yield* history()).rows.find(
          (item) => item.kind === "task" && item.task.taskId === taskId,
        );
        assert.isTrue(current.unread);
        assert.strictEqual(fromHistory?.kind === "task" && fromHistory.unread, current.unread);
        assert.strictEqual(
          fromHistory?.kind === "task" && fromHistory.lastActivityAt,
          current.lastActivityAt,
        );
      }),
    ),
  );
});
