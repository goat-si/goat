import { assert, describe, it } from "@effect/vitest";
import { ChannelOutboundMessage } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ChannelDeliveryWorker from "./ChannelDeliveryWorker.ts";
import { claimDueStatement } from "./channelDeliveryLedger.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import { progressStatements } from "./channelProgressMessages.ts";
import * as ChannelReceptionService from "./ChannelReceptionService.ts";
import {
  makeProgressHarness,
  startSlackTask,
  type OutboxRow,
} from "./testkit/slackProgressHarness.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(ChannelOutboundMessage));
const textOf = (row: OutboxRow) => decode(row.message_json).text;

describe("progress writes across a restart", () => {
  it.effect(
    "a handed-over edit becomes ambiguous, is never copied to the bot's chat, and still allows the restore",
    () => {
      const h = makeProgressHarness();
      return Effect.gen(function* () {
        const t = yield* startSlackTask(h, "restart-edit");
        const ledger = yield* ChannelLedger.ChannelLedger;
        const worker = yield* ChannelDeliveryWorker.ChannelDeliveryWorker;
        yield* t.milestone("Checking images.");
        yield* TestClock.adjust("15 seconds");
        const held = yield* h.hold;
        yield* worker.deliverDue(t.runtime.ownerToken);
        yield* Deferred.await(held.reached);
        yield* ledger.settleInterruptedDeliveries({
          owner: t.runtime.ownerToken,
          now: yield* nowIso,
        });
        yield* Deferred.succeed(held.open, undefined);
        yield* worker.settleReceipts;
        const [edit] = yield* t.ofOperation("edit");
        assert.deepStrictEqual([edit?.state, edit?.last_error_code], ["ambiguous", "interrupted"]);
        const copies = yield* t.sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM channel_outbox
          WHERE cause_key LIKE 'undelivered:%'`;
        assert.strictEqual(copies[0]?.n, 0);
        yield* t.finishSilently();
        assert.deepStrictEqual(h.calls.at(-1), {
          operation: "edit",
          ts: t.ack.ts!,
          text: t.ack.text,
        });
      }).pipe(Effect.provide(h.layer));
    },
  );

  it.effect(
    "an edit claimed but never handed over goes again, or is dropped for a newer one",
    () => {
      const h = makeProgressHarness();
      return Effect.gen(function* () {
        const t = yield* startSlackTask(h, "restart-unsent");
        const ledger = yield* ChannelLedger.ChannelLedger;
        yield* t.milestone("Checking images.");
        yield* TestClock.adjust("15 seconds");
        const claimed = yield* ledger.claimDue({
          owner: t.runtime.ownerToken,
          now: yield* nowIso,
          limit: 1,
          receiptsOnly: false,
        });
        assert.strictEqual(claimed.deliveries[0]?.progress?.operation, "edit");
        yield* ledger.settleInterruptedDeliveries({
          owner: t.runtime.ownerToken,
          now: yield* nowIso,
        });
        assert.strictEqual((yield* t.ofOperation("edit"))[0]?.state, "pending");
        yield* t.runtime.drain;
        assert.deepStrictEqual(h.calls, [
          { operation: "edit", ts: t.ack.ts!, text: t.ack.text + "\n\nChecking images." },
        ]);
        yield* t.milestone("Pruning images.");
        yield* TestClock.adjust("15 seconds");
        yield* ledger.claimDue({
          owner: t.runtime.ownerToken,
          now: yield* nowIso,
          limit: 1,
          receiptsOnly: false,
        });
        yield* ledger.settleInterruptedDeliveries({
          owner: t.runtime.ownerToken,
          now: yield* nowIso,
        });
        yield* t.milestone("Done pruning.");
        const edits = yield* t.ofOperation("edit");
        assert.deepStrictEqual(
          edits.map((row) => [textOf(row), row.state]),
          [
            ["Checking images.", "delivered"],
            ["Pruning images.", "superseded"],
            ["Done pruning.", "delivered"],
          ],
        );
        assert.strictEqual(h.calls.at(-1)?.text, t.ack.text + "\n\nDone pruning.");
      }).pipe(Effect.provide(h.layer));
    },
  );

  it.effect(
    "between claim and hand-over, a newer Slack row of the task drops the edit; a bot-chat copy or GOAT chip does not",
    () => {
      const h = makeProgressHarness();
      return Effect.gen(function* () {
        const t = yield* startSlackTask(h, "restart-overtaken");
        const ledger = yield* ChannelLedger.ChannelLedger;
        const [goat] = yield* t.sql<{ readonly message_json: string }>`SELECT message_json
          FROM channel_outbox WHERE task_id = ${t.task.taskId} AND destination_kind = 'goat' LIMIT 1`;
        const insert = (id: string, destination: "slack" | "goat", kind: string) =>
          t.sql`INSERT INTO channel_outbox ${t.sql.insert({
            delivery_id: id,
            cause_key: "test:" + id,
            input_id: null,
            task_id: t.task.taskId,
            kind,
            destination_kind: destination,
            message_json: JSON.stringify({
              ...JSON.parse(destination === "slack" ? t.ack.message_json : goat!.message_json),
              deliveryId: id,
              kind,
              text: id,
              taskId: t.task.taskId,
            }),
            state: "pending",
            attempts: 0,
            next_attempt_at: "2999-01-01T00:00:00.000Z",
            created_at: "1970-01-01T00:00:00.000Z",
            updated_at: "1970-01-01T00:00:00.000Z",
          })}`;
        const claimEdit = Effect.gen(function* () {
          yield* TestClock.adjust("15 seconds");
          const claimed = yield* ledger.claimDue({
            owner: t.runtime.ownerToken,
            now: yield* nowIso,
            limit: 1,
            receiptsOnly: false,
          });
          const [delivery] = claimed.deliveries;
          assert.strictEqual(delivery?.progress?.operation, "edit");
          return delivery!;
        });
        yield* t.milestone("Step one.");
        const first = yield* claimEdit;
        yield* insert("bot-copy", "goat", "receipt");
        yield* insert("chip", "goat", "task_chip");
        assert.isTrue(
          yield* ledger.markSending({
            owner: t.runtime.ownerToken,
            deliveryId: first.deliveryId,
            attempt: first.attempts,
            now: yield* nowIso,
          }),
        );
        yield* ledger.recordDelivery({
          owner: t.runtime.ownerToken,
          deliveryId: first.deliveryId,
          attempt: first.attempts,
          now: yield* nowIso,
          outcome: { type: "delivered" },
        });
        yield* t.milestone("Step two.");
        const second = yield* claimEdit;
        yield* insert("newer-question", "slack", "question");
        assert.isFalse(
          yield* ledger.markSending({
            owner: t.runtime.ownerToken,
            deliveryId: second.deliveryId,
            attempt: second.attempts,
            now: yield* nowIso,
          }),
        );
        const edits = yield* t.ofOperation("edit");
        assert.deepStrictEqual(
          edits.map((row) => row.state),
          ["delivered", "superseded"],
        );
      }).pipe(Effect.provide(h.layer));
    },
  );

  it.effect("an end row never handed over goes again after a restart", () => {
    const h = makeProgressHarness();
    return Effect.gen(function* () {
      const t = yield* startSlackTask(h, "restart-end-unsent");
      const ledger = yield* ChannelLedger.ChannelLedger;
      const reception = yield* ChannelReceptionService.ChannelReceptionService;
      yield* t.acknowledgedBy("fixed");
      h.harness.world.setStatus(
        t.task.worker!.threadId,
        1,
        "completed",
        "Docker images take 41 GB.",
      );
      yield* t.reports.reconcile(t.runtime.ownerToken);
      for (const pending of yield* ledger.listPendingNarrations(20)) {
        yield* reception.narrate(pending, t.runtime.ownerToken);
      }
      // The answer went out before the restart.
      yield* t.sql`UPDATE channel_outbox SET state = 'delivered' WHERE task_id = ${t.task.taskId}
        AND destination_kind = 'slack' AND kind = 'result'`;
      const claimed = yield* ledger.claimDue({
        owner: t.runtime.ownerToken,
        now: yield* nowIso,
        limit: 10,
        receiptsOnly: false,
      });
      assert.deepStrictEqual(
        claimed.deliveries.flatMap((delivery) =>
          delivery.progress === undefined ? [] : [delivery.progress.operation],
        ),
        ["delete"],
      );
      yield* ledger.settleInterruptedDeliveries({
        owner: t.runtime.ownerToken,
        now: yield* nowIso,
      });
      yield* t.runtime.drain;
      assert.deepStrictEqual(h.calls, [{ operation: "remove", ts: t.ack.ts! }]);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("an end row handed over before a restart is ambiguous, never retried or copied", () => {
    const h = makeProgressHarness();
    return Effect.gen(function* () {
      const t = yield* startSlackTask(h, "restart-end-sent");
      const ledger = yield* ChannelLedger.ChannelLedger;
      const worker = yield* ChannelDeliveryWorker.ChannelDeliveryWorker;
      yield* t.acknowledgedBy("fixed");
      const held = yield* h.hold;
      h.harness.world.setStatus(
        t.task.worker!.threadId,
        1,
        "completed",
        "Docker images take 41 GB.",
      );
      yield* t.reports.reconcile(t.runtime.ownerToken);
      yield* t.runtime.runPass;
      yield* t.runtime.runPass;
      yield* Deferred.await(held.reached);
      yield* ledger.settleInterruptedDeliveries({
        owner: t.runtime.ownerToken,
        now: yield* nowIso,
      });
      yield* Deferred.succeed(held.open, undefined);
      yield* worker.settleReceipts;
      yield* TestClock.adjust("60 seconds");
      yield* t.runtime.drain;
      assert.deepStrictEqual(h.calls, [{ operation: "remove", ts: t.ack.ts! }]);
      const [end] = yield* t.ofOperation("end");
      assert.strictEqual(end?.state, "ambiguous");
      const copies = yield* t.sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM channel_outbox
        WHERE cause_key LIKE 'undelivered:%'`;
      assert.strictEqual(copies[0]?.n, 0);
    }).pipe(Effect.provide(h.layer));
  });
});

describe("one Slack write per progress message at a time", () => {
  it.effect("a second edit waits while the first is with Slack, then goes", () => {
    const h = makeProgressHarness();
    return Effect.gen(function* () {
      const t = yield* startSlackTask(h, "one-in-flight");
      const worker = yield* ChannelDeliveryWorker.ChannelDeliveryWorker;
      yield* t.milestone("Step one.");
      yield* TestClock.adjust("15 seconds");
      const held = yield* h.hold;
      yield* worker.deliverDue(t.runtime.ownerToken);
      yield* Deferred.await(held.reached);
      yield* t.report("Step two.");
      // A pass narrates the milestone and claims it, without waiting on the held edit.
      yield* t.runtime.runPass;
      yield* TestClock.adjust("15 seconds");
      // drain would wait on the held edit, so the worker is driven directly.
      yield* worker.deliverDue(t.runtime.ownerToken);
      assert.lengthOf(h.calls, 1);
      const edits = yield* t.ofOperation("edit");
      assert.deepStrictEqual(
        edits.map((row) => row.state),
        ["delivering", "pending"],
      );
      yield* Deferred.succeed(held.open, undefined);
      yield* worker.settleReceipts;
      yield* t.runtime.drain;
      assert.deepStrictEqual(h.calls.slice(1), [
        { operation: "edit", ts: t.ack.ts!, text: t.ack.text + "\n\nStep two." },
      ]);
    }).pipe(Effect.provide(h.layer));
  });
});

describe("channels without edits", () => {
  it.effect("an iMessage task keeps one message before the answer and is never edited", () => {
    const h = makeProgressHarness();
    return Effect.gen(function* () {
      const t = yield* startSlackTask(h, "imessage");
      const ledger = yield* ChannelLedger.ChannelLedger;
      const imessage = { kind: "imessage", connectionId: "im-1", chatGuid: "chat-1" };
      yield* t.sql`UPDATE channel_outbox SET destination_kind = 'imessage',
        message_json = json_set(message_json, '$.destination', json(${JSON.stringify(imessage)}))
        WHERE delivery_id = ${t.ack.delivery_id}`;
      yield* t.sql`INSERT INTO channel_outbox ${t.sql.insert({
        delivery_id: "im-milestone",
        cause_key: "test:im-milestone",
        input_id: null,
        task_id: t.task.taskId,
        kind: "receipt",
        destination_kind: "imessage",
        message_json: JSON.stringify({
          deliveryId: "im-milestone",
          destination: imessage,
          kind: "receipt",
          text: "Checking images.",
          taskId: t.task.taskId,
          interim: true,
        }),
        state: "pending",
        attempts: 0,
        next_attempt_at: "1970-01-01T00:00:00.000Z",
        created_at: "1970-01-01T00:00:00.000Z",
        updated_at: "1970-01-01T00:00:00.000Z",
      })}`;
      const claimed = yield* ledger.claimDue({
        owner: t.runtime.ownerToken,
        now: yield* nowIso,
        limit: 1,
        receiptsOnly: false,
      });
      assert.deepStrictEqual(claimed.deliveries, []);
      const [row] = yield* t.sql<{ readonly operation: string; readonly state: string }>`SELECT
        operation, state FROM channel_outbox WHERE delivery_id = 'im-milestone'`;
      assert.deepStrictEqual([row?.operation, row?.state], ["post", "superseded"]);
    }).pipe(Effect.provide(h.layer));
  });
});

describe("progress queries read the outbox through its indexes", () => {
  it.effect("the claim and every progress statement search channel_outbox, never scan it", () => {
    const h = makeProgressHarness();
    return Effect.gen(function* () {
      const t = yield* startSlackTask(h, "plans");
      const q = progressStatements(t.sql);
      const now = yield* nowIso;
      const statements = {
        claim: claimDueStatement(t.sql, { now, limit: 1, receiptsOnly: false }),
        claimAll: claimDueStatement(t.sql, { now, limit: 1, receiptsOnly: undefined }),
        replyRow: q.replyRow("input-1"),
        firstInterim: q.firstInterim("task-1"),
        targetEnded: q.targetEnded("target-1"),
        lastSendStarted: q.lastSendStarted("target-1"),
        lastShown: q.lastShown("target-1", "edit-1"),
        editShown: q.editShown("target-1"),
        answerState: q.answerState("task-1"),
        overtaken: q.overtaken({
          taskId: "task-1",
          destinationKind: "slack",
          rowOrder: 1,
          targetDeliveryId: "target-1",
        }),
        supersedeTargetEdits: q.supersedeTargetEdits({
          targetDeliveryId: "target-1",
          before: 10,
          now,
        }),
        supersedeTaskEdits: q.supersedeTaskEdits({
          taskId: "task-1",
          destinationKind: "slack",
          except: "row-1",
          now,
        }),
      };
      for (const [name, statement] of Object.entries(statements)) {
        const plan = yield* t.sql<{
          readonly id: number;
          readonly parent: number;
          readonly detail: string;
        }>`EXPLAIN QUERY PLAN ${statement}`;
        const details = plan.map((row) => row.detail);
        const lines = name + "\n" + details.join("\n");
        assert.isTrue(
          details.some((detail) => /^SEARCH \w+ USING/.test(detail)),
          lines,
        );
        assert.isFalse(
          details.some((detail) => detail.startsWith("SCAN") && detail !== "SCAN CONSTANT ROW"),
          lines,
        );
        // Only the claim sorts, and only its own due rows, oldest first, as it did before.
        const dueSelection = plan
          .filter((row) => name.startsWith("claim") && row.detail.startsWith("LIST SUBQUERY"))
          .map((row) => row.id);
        assert.isTrue(
          plan
            .filter((row) => row.detail.includes("TEMP B-TREE"))
            .every((row) => dueSelection.includes(row.parent)),
          lines,
        );
      }
    }).pipe(Effect.provide(h.layer));
  });
});
