import { assert, describe, it } from "@effect/vitest";
import type { ChannelReceptionInput } from "@goat/contracts";
import { ProviderInstanceId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSettings from "../serverSettings.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelDeliveryWorker from "./ChannelDeliveryWorker.ts";
import * as ChannelWake from "./ChannelWake.ts";
import { ChannelLedgerError } from "./channelLedgerError.ts";
import { deliveryIdFor } from "./channelIds.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import * as ChannelWorkerReports from "./ChannelWorkerReports.ts";
import { receptionDecisionChannels } from "./testkit/channelReceptionHarness.ts";
import {
  botMessages,
  defaultScript,
  linkSlackUser,
  makeHarness,
  modelSelection,
  onlyTask,
  setupBot,
  slackContext,
  slackInput,
} from "./testkit/ChannelHarness.ts";

const botModel = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-luna" } as const;

/** "look:" asks GOAT Bot to take a turn itself. */
const turnScript = (input: ChannelReceptionInput) =>
  input.mode === "input" && (input.inputText ?? "").startsWith("look:")
    ? Effect.succeed({
        replyText: "On it.",
        action: {
          type: "run_turn" as const,
          title: "Look into it",
          instruction: (input.inputText ?? "").slice(5).trim(),
        },
      })
    : defaultScript(input);

const harnessWith = (goatBotModelSelection: typeof botModel) => {
  const harness = makeHarness({
    botWorkspace: true,
    channelsLayer: receptionDecisionChannels,
    settingsLayer: ServerSettings.layerTest({
      textGenerationModelSelection: modelSelection,
      goatBotModelSelection,
    }).pipe(Layer.orDie),
  });
  harness.script.current = turnScript;
  return harness;
};

describe("progress on channels that cannot take a message back", () => {
  it.effect(
    "a Slack turn sends one message before its answer: later milestones reach only the bot's chat",
    () => {
      const harness = harnessWith(botModel);
      return Effect.gen(function* () {
        yield* setupBot;
        yield* linkSlackUser();
        const gateway = yield* ChannelGateway.ChannelGateway;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
        yield* gateway.ingest(slackInput("look: why is the disk full?", "Ev21"), slackContext);
        yield* runtime.drain;
        yield* reports.reconcile(runtime.ownerToken);
        const task = yield* onlyTask;
        for (const [eventId, summary] of [
          ["slack-progress-1", "Listing the largest folders now."],
          ["slack-progress-2", "Docker looks like the culprit; checking images."],
        ] as const)
          yield* reports.report(
            {
              taskId: task.taskId,
              generation: task.generation,
              eventId: eventId as never,
              status: "running",
              summary,
            },
            task.worker!.threadId,
          );
        yield* runtime.drain;
        harness.world.setStatus(task.worker!.threadId, 1, "completed", "Docker images take 41 GB.");
        yield* reports.reconcile(runtime.ownerToken);
        yield* runtime.drain;
        const kinds = harness.slackSent
          .filter((send) => send.message.taskId === task.taskId)
          .map((send) => send.message.kind);
        assert.deepStrictEqual(kinds, ["receipt", "result"]);
        // The bot's own chat keeps every step, which its progress line reads.
        const texts = (yield* botMessages).messages.map((message) => message.text);
        assert.include(texts, "Listing the largest folders now.");
        assert.include(texts, "Docker looks like the culprit; checking images.");
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "a Slack turn whose acknowledgement never arrived sends its first milestone, and only that one",
    () => {
      const harness = harnessWith(botModel);
      return Effect.gen(function* () {
        yield* setupBot;
        yield* linkSlackUser();
        const gateway = yield* ChannelGateway.ChannelGateway;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
        yield* gateway.ingest(slackInput("look: why is the disk full?", "Ev22"), slackContext);
        yield* runtime.drain;
        yield* reports.reconcile(runtime.ownerToken);
        const task = yield* onlyTask;
        // The acknowledgement expired undelivered, so the person has heard nothing yet.
        yield* (yield* SqlClient.SqlClient)`UPDATE channel_outbox SET state = 'failed'
          WHERE cause_key = ${"reply:" + task.originInputId}`;
        const sentBefore = harness.slackSent.length;
        for (const [eventId, summary] of [
          ["slack-late-1", "Listing the largest folders now."],
          ["slack-late-2", "Docker looks like the culprit; checking images."],
        ] as const)
          yield* reports.report(
            {
              taskId: task.taskId,
              generation: task.generation,
              eventId: eventId as never,
              status: "running",
              summary,
            },
            task.worker!.threadId,
          );
        yield* runtime.drain;
        assert.deepStrictEqual(
          harness.slackSent.slice(sentBefore).map((send) => send.message.text),
          ["Listing the largest folders now."],
        );
      }).pipe(Effect.provide(harness.layer));
    },
  );
});

const startSlackTurn = (harness: ReturnType<typeof harnessWith>, eventId: string) =>
  Effect.gen(function* () {
    yield* setupBot;
    yield* linkSlackUser();
    const gateway = yield* ChannelGateway.ChannelGateway;
    const runtime = yield* ChannelRuntime.ChannelRuntime;
    const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
    yield* gateway.ingest(slackInput("look: why is the disk full?", eventId), slackContext);
    yield* runtime.drain;
    yield* reports.reconcile(runtime.ownerToken);
    const task = yield* onlyTask;
    const sql = yield* SqlClient.SqlClient;
    const progress = (id: string, summary: string) =>
      reports.report(
        {
          taskId: task.taskId,
          generation: task.generation,
          eventId: id as never,
          status: "running",
          summary,
        },
        task.worker!.threadId,
      );
    const sentSince = (count: number) =>
      harness.slackSent.slice(count).map((send) => send.message.text);
    return { runtime, task, sql, progress, sentSince, ackKey: "reply:" + task.originInputId };
  });

describe("one message before the answer, whatever the order", () => {
  it.effect(
    "a milestone reported before the acknowledgement was recorded stays out once the acknowledgement is sent",
    () => {
      const harness = harnessWith(botModel);
      return Effect.gen(function* () {
        const { runtime, sql, progress, sentSince, ackKey } = yield* startSlackTurn(
          harness,
          "Ev31",
        );
        const [ack] = yield* sql<Record<string, unknown>>`
          SELECT * FROM channel_outbox WHERE cause_key = ${ackKey}`;
        yield* sql`DELETE FROM channel_outbox WHERE cause_key = ${ackKey}`;
        const before = harness.slackSent.length;
        yield* progress("order-early-1", "Listing the largest folders now.");
        yield* runtime.drain;
        // The acknowledgement (the 20 s line or the 55 s fallback) is recorded after the milestone.
        yield* sql`INSERT INTO channel_outbox ${sql.insert({ ...ack!, state: "pending", attempts: 0 })}`;
        yield* runtime.drain;
        assert.deepStrictEqual(sentSince(before), [JSON.parse(String(ack!.message_json)).text]);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "a milestone that waits on an acknowledgement still sending goes out when that acknowledgement fails",
    () => {
      const harness = harnessWith(botModel);
      return Effect.gen(function* () {
        const { runtime, sql, progress, sentSince, ackKey } = yield* startSlackTurn(
          harness,
          "Ev32",
        );
        yield* sql`UPDATE channel_outbox SET state = 'pending',
          next_attempt_at = '2999-01-01T00:00:00.000Z' WHERE cause_key = ${ackKey}`;
        const before = harness.slackSent.length;
        yield* progress("order-pending-1", "Listing the largest folders now.");
        yield* runtime.drain;
        assert.deepStrictEqual(sentSince(before), []);
        yield* sql`UPDATE channel_outbox SET state = 'failed' WHERE cause_key = ${ackKey}`;
        yield* runtime.drain;
        assert.deepStrictEqual(sentSince(before), ["Listing the largest folders now."]);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "every interim message of a task follows the rule, while its questions always go",
    () => {
      const harness = harnessWith(botModel);
      return Effect.gen(function* () {
        const { runtime, task, sql, sentSince, ackKey } = yield* startSlackTurn(harness, "Ev33");
        const [ack] = yield* sql<{
          readonly message_json: string;
          readonly destination_kind: string;
        }>`
          SELECT message_json, destination_kind FROM channel_outbox WHERE cause_key = ${ackKey}`;
        const row = (id: string, kind: string, text: string, interim?: true) => ({
          delivery_id: id,
          cause_key: "test:" + id,
          input_id: null,
          task_id: task.taskId,
          kind,
          destination_kind: ack!.destination_kind,
          message_json: JSON.stringify({
            ...JSON.parse(ack!.message_json),
            deliveryId: id,
            kind,
            text,
            taskId: task.taskId,
            ...(interim === undefined ? {} : { interim }),
          }),
          state: "pending",
          attempts: 0,
          next_attempt_at: "1970-01-01T00:00:00.000Z",
          created_at: "1970-01-01T00:00:00.000Z",
          updated_at: "1970-01-01T00:00:00.000Z",
        });
        const before = harness.slackSent.length;
        // Where the work runs, or that it moved to another machine, is an interim message too.
        yield* sql`INSERT INTO channel_outbox ${sql.insert(row("moved", "receipt", "Moved to mac-studio.", true))}`;
        yield* sql`INSERT INTO channel_outbox ${sql.insert(row("asked", "question", "Delete the old images?"))}`;
        yield* runtime.drain;
        assert.deepStrictEqual(sentSince(before), ["Delete the old images?"]);
        const [moved] = yield* sql<{ readonly state: string }>`
          SELECT state FROM channel_outbox WHERE delivery_id = 'moved'`;
        assert.strictEqual(moved?.state, "superseded");
      }).pipe(Effect.provide(harness.layer));
    },
  );
});

describe("hand-over persistence recovery", () => {
  it.effect(
    "releases a failed hand-over after persistence recovers and sends the task's later message",
    () => {
      const harness = harnessWith(botModel);
      return Effect.gen(function* () {
        const { task } = yield* startSlackTurn(harness, "release-retry");
        const ledger = yield* ChannelLedger.ChannelLedger;
        const failed = yield* Deferred.make<void>();
        const sent: string[] = [];
        let marks = 0;
        let releases = 0;
        const error = new ChannelLedgerError({ reason: "persistence", detail: "unavailable" });
        const wrapped = {
          ...ledger,
          markSending: (input: Parameters<typeof ledger.markSending>[0]) =>
            ++marks === 1 ? Effect.fail(error) : ledger.markSending(input),
          recordDelivery: (input: Parameters<typeof ledger.recordDelivery>[0]) =>
            input.outcome.type === "retry" && ++releases === 1
              ? Deferred.succeed(failed, undefined).pipe(Effect.andThen(Effect.fail(error)))
              : ledger.recordDelivery(input),
        };
        const now = DateTime.formatIso(yield* DateTime.now);
        const rows = ["release-first", "release-later"].map((key) => ({
          deliveryId: deliveryIdFor(key),
          causeKey: key,
          taskId: task.taskId,
          message: {
            deliveryId: deliveryIdFor(key),
            destination: task.originAddress,
            kind: "question" as const,
            text: key,
            taskId: task.taskId,
          },
        }));
        yield* ledger.enqueueDeliveries(rows, now);
        const services = ChannelDeliveryWorker.layer.pipe(
          Layer.provide(Layer.succeed(ChannelLedger.ChannelLedger)(wrapped)),
          Layer.provide(
            Layer.mock(ChannelGateway.ChannelGateway)({
              send: (message) =>
                Effect.sync(() => {
                  sent.push(message.text);
                  return { deliveryId: message.deliveryId, acceptedAt: now };
                }),
            }),
          ),
          Layer.provide(ChannelWake.layer),
        );
        yield* Effect.gen(function* () {
          const worker = yield* ChannelDeliveryWorker.ChannelDeliveryWorker;
          const pass = yield* worker
            .deliverDue((yield* ChannelRuntime.ChannelRuntime).ownerToken)
            .pipe(Effect.forkChild);
          yield* Effect.raceFirst(
            Deferred.await(failed),
            Fiber.join(pass).pipe(Effect.andThen(Effect.die("release was not attempted"))),
          );
          yield* TestClock.adjust("5 seconds");
          yield* Fiber.join(pass);
          assert.strictEqual(
            yield* ledger.getDeliveryState(deliveryIdFor("release-first")),
            "pending",
          );
          assert.deepStrictEqual(sent, []);
          yield* TestClock.adjust("5 seconds");
          yield* worker.deliverDue((yield* ChannelRuntime.ChannelRuntime).ownerToken);
          assert.deepStrictEqual(sent, ["release-first", "release-later"]);
        }).pipe(Effect.provide(Layer.fresh(services)));
      }).pipe(Effect.provide(harness.layer));
    },
  );
});

describe("pre-upgrade narration", () => {
  it.effect(
    "counts legacy progress and suppresses legacy placement and moves, but sends questions and failures",
    () => {
      const harness = harnessWith(botModel);
      return Effect.gen(function* () {
        const { runtime, task, sql, sentSince, ackKey } = yield* startSlackTurn(
          harness,
          "legacy-interim",
        );
        yield* sql`UPDATE channel_outbox SET state = 'failed' WHERE cause_key = ${ackKey}`;
        const [ack] = yield* sql<{
          readonly message_json: string;
          readonly destination_kind: string;
        }>`
        SELECT message_json, destination_kind FROM channel_outbox WHERE cause_key = ${ackKey}`;
        const [version] = yield* sql<{ readonly n: number }>`
        SELECT MAX(task_version) AS n FROM channel_task_events WHERE task_id = ${task.taskId}`;
        const rows = [
          ["legacy-progress", "task.progress", "receipt", "Working"],
          ["legacy-placement", "task.dispatch.claimed", "receipt", "Placed"],
          ["legacy-move", "task.moved", "receipt", "Moved"],
          ["legacy-question", "task.question.opened", "question", "Proceed?"],
          ["legacy-failure", "task.failed", "failure", "Failed"],
        ] as const;
        for (const [index, [id, type, kind, text]] of rows.entries()) {
          yield* sql`INSERT INTO channel_task_events (event_id, task_id, task_version, type, event_json, occurred_at)
          VALUES (${id}, ${task.taskId}, ${version!.n + index + 1}, ${type}, '{}', '1970-01-01T00:00:00.000Z')`;
          yield* sql`INSERT INTO channel_outbox ${sql.insert({
            delivery_id: id,
            cause_key: "narration:" + id + ":origin",
            input_id: null,
            task_id: task.taskId,
            kind,
            destination_kind: ack!.destination_kind,
            message_json: JSON.stringify({
              ...JSON.parse(ack!.message_json),
              deliveryId: id,
              kind,
              text,
              taskId: task.taskId,
            }),
            state: "pending",
            attempts: 0,
            next_attempt_at: "1970-01-01T00:00:00.000Z",
            created_at: "1970-01-01T00:00:00.000Z",
            updated_at: "1970-01-01T00:00:00.000Z",
          })}`;
        }
        const before = harness.slackSent.length;
        yield* runtime.drain;
        assert.deepStrictEqual(sentSince(before), ["Working", "Proceed?", "Failed"]);
      }).pipe(Effect.provide(harness.layer));
    },
  );
});

describe("what still reaches the person after the one message before the answer", () => {
  it.effect(
    "an approval result, a refused note change and a stall warning are delivered after the acknowledgement",
    () => {
      const harness = harnessWith(botModel);
      return Effect.gen(function* () {
        const { runtime, task, sql, sentSince, ackKey } = yield* startSlackTurn(harness, "Ev41");
        const [ack] = yield* sql<{
          readonly message_json: string;
          readonly destination_kind: string;
          readonly state: string;
        }>`SELECT message_json, destination_kind, state FROM channel_outbox WHERE cause_key = ${ackKey}`;
        assert.strictEqual(ack?.state, "delivered");
        const row = (causeKey: string, text: string) => ({
          delivery_id: causeKey,
          cause_key: causeKey,
          input_id: null,
          task_id: task.taskId,
          kind: "receipt",
          destination_kind: ack!.destination_kind,
          message_json: JSON.stringify({
            ...JSON.parse(ack!.message_json),
            deliveryId: causeKey,
            kind: "receipt",
            text,
            taskId: task.taskId,
          }),
          state: "pending",
          attempts: 0,
          next_attempt_at: "1970-01-01T00:00:00.000Z",
          created_at: "1970-01-01T00:00:00.000Z",
          updated_at: "1970-01-01T00:00:00.000Z",
        });
        const before = harness.slackSent.length;
        const notices = [
          ["late-approval:" + task.taskId + ":r1", "Approved in the coding thread. It continues."],
          ["note-request:in-1:forget:not_found", "I couldn't find that note, so nothing changed."],
          ["stall:" + task.taskId + ":run-1:t0", "It has made no progress for 20 minutes."],
        ] as const;
        for (const [causeKey, text] of notices)
          yield* sql`INSERT INTO channel_outbox ${sql.insert(row(causeKey, text))}`;
        yield* runtime.drain;
        assert.deepStrictEqual(
          sentSince(before),
          notices.map(([, text]) => text),
        );
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "a restart between claiming a milestone and sending it still leaves exactly one progress message",
    () => {
      const harness = harnessWith(botModel);
      return Effect.gen(function* () {
        const { runtime, task, sql, progress, sentSince, ackKey } = yield* startSlackTurn(
          harness,
          "Ev42",
        );
        const ledger = yield* ChannelLedger.ChannelLedger;
        // Nobody heard the acknowledgement, so the first milestone is the one message.
        yield* sql`UPDATE channel_outbox SET state = 'failed' WHERE cause_key = ${ackKey}`;
        const [ack] = yield* sql<{
          readonly message_json: string;
          readonly destination_kind: string;
        }>`
          SELECT message_json, destination_kind FROM channel_outbox WHERE cause_key = ${ackKey}`;
        yield* runtime.drain;
        const before = harness.slackSent.length;
        yield* sql`INSERT INTO channel_outbox ${sql.insert({
          delivery_id: "restart-1",
          cause_key: "narration:restart-1:origin",
          input_id: null,
          task_id: task.taskId,
          kind: "receipt",
          destination_kind: ack!.destination_kind,
          message_json: JSON.stringify({
            ...JSON.parse(ack!.message_json),
            deliveryId: "restart-1",
            kind: "receipt",
            text: "Listing the largest folders now.",
            taskId: task.taskId,
            interim: true,
          }),
          state: "pending",
          attempts: 0,
          next_attempt_at: "1970-01-01T00:00:00.000Z",
          created_at: "1970-01-01T00:00:00.000Z",
          updated_at: "1970-01-01T00:00:00.000Z",
        })}`;
        const now = DateTime.formatIso(yield* DateTime.now);
        const claimed = yield* ledger.claimDueDeliveries({
          owner: runtime.ownerToken,
          now,
          limit: 1,
          receiptsOnly: false,
        });
        assert.deepStrictEqual(
          claimed.map((delivery) => delivery.deliveryId),
          ["restart-1"],
        );
        // The server stops before handing the row to Slack.
        yield* ledger.settleInterruptedDeliveries({ owner: runtime.ownerToken, now });
        yield* progress("restart-2", "Docker looks like the culprit; checking images.");
        yield* runtime.drain;
        assert.deepStrictEqual(sentSince(before), ["Listing the largest folders now."]);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("a long backlog of milestones is set aside in bounded batches", () => {
    const harness = harnessWith(botModel);
    return Effect.gen(function* () {
      const { runtime, task, sql, sentSince, ackKey } = yield* startSlackTurn(harness, "Ev43");
      const ledger = yield* ChannelLedger.ChannelLedger;
      const [ack] = yield* sql<{
        readonly message_json: string;
        readonly destination_kind: string;
      }>`
        SELECT message_json, destination_kind FROM channel_outbox WHERE cause_key = ${ackKey}`;
      const backlog = 300;
      for (let index = 0; index < backlog; index++) {
        const id = "backlog-" + String(index).padStart(3, "0");
        yield* sql`INSERT INTO channel_outbox ${sql.insert({
          delivery_id: id,
          cause_key: "narration:" + id + ":origin",
          input_id: null,
          task_id: task.taskId,
          kind: "receipt",
          destination_kind: ack!.destination_kind,
          message_json: JSON.stringify({
            ...JSON.parse(ack!.message_json),
            deliveryId: id,
            kind: "receipt",
            text: "Step " + index,
            taskId: task.taskId,
            interim: true,
          }),
          state: "pending",
          attempts: 0,
          next_attempt_at: "1970-01-01T00:00:00.000Z",
          created_at: "1970-01-01T00:00:00.000Z",
          updated_at: "1970-01-01T00:00:00.000Z",
        })}`;
      }
      const before = harness.slackSent.length;
      const setAside = () =>
        sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM channel_outbox
          WHERE delivery_id LIKE 'backlog-%' AND state = 'superseded'`.pipe(
          Effect.map((rows) => rows[0]?.count ?? 0),
        );
      const claimed = yield* ledger.claimDueDeliveries({
        owner: runtime.ownerToken,
        now: DateTime.formatIso(yield* DateTime.now),
        limit: 1,
        receiptsOnly: false,
      });
      assert.deepStrictEqual(claimed, []);
      const firstBatch = yield* setAside();
      assert.isAbove(firstBatch, 0);
      assert.isAtMost(firstBatch, 100);
      yield* runtime.drain;
      assert.strictEqual(yield* setAside(), backlog);
      assert.deepStrictEqual(sentSince(before), []);
    }).pipe(Effect.provide(harness.layer));
  });
});

describe("a real stall warning on Slack", () => {
  it.effect("goes out after the acknowledgement, written by the stall check itself", () => {
    const harness = harnessWith(botModel);
    return Effect.gen(function* () {
      const { runtime, task, sentSince } = yield* startSlackTurn(harness, "Ev44");
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      harness.world.activityAt.set(task.worker!.threadId, yield* DateTime.now);
      const before = harness.slackSent.length;
      yield* TestClock.adjust(Duration.minutes(20));
      yield* TestClock.adjust(Duration.millis(1));
      yield* reports.reconcile(runtime.ownerToken);
      yield* runtime.drain;
      const sent = sentSince(before);
      assert.strictEqual(sent.length, 1);
      assert.include(sent[0], "has made no progress for 20 minutes");
    }).pipe(Effect.provide(harness.layer));
  });
});
