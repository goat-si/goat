import { assert, describe, it } from "@effect/vitest";
import { ChannelReceptionId, type ChannelInputId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelReceptionService from "./ChannelReceptionService.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import {
  defaultScript,
  goatInput,
  linkSlackUser,
  makeHarness,
  makeRuntime,
  onlyTask,
  rpcContext,
  setupBot,
  slackContext,
  slackInput,
} from "./testkit/ChannelHarness.ts";

const claim = Effect.fn("DeadlineTest.claim")(function* (owner: string) {
  const ledger = yield* ChannelLedger.ChannelLedger;
  const now = DateTime.formatIso(yield* DateTime.now);
  assert.isTrue(yield* ledger.claimOwnership({ token: owner, now, staleBefore: now }));
});

const replies = Effect.fn("DeadlineTest.replies")(function* (inputId: ChannelInputId) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ readonly kind: string; readonly state: string; readonly text: string }>`
    SELECT json_extract(message_json, '$.kind') AS kind, state,
      json_extract(message_json, '$.text') AS text
    FROM channel_outbox WHERE cause_key = ${"reply:" + inputId}
  `;
});

const failedInput = Effect.fn("DeadlineTest.failedInput")(function* (inputId: ChannelInputId) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly state: string;
  }>`SELECT state FROM channel_inbox WHERE input_id = ${inputId}`;
  assert.strictEqual(rows[0]?.state, "failed");
  const ledger = yield* ChannelLedger.ChannelLedger;
  assert.deepStrictEqual((yield* ledger.getInput(inputId))?.snapshot.failure, {
    reason: "reception_failed",
    message: "I couldn't read that: the model took too long to answer. Please send it again.",
  });
});

describe("channel first-reply deadline", () => {
  it.effect("expires four hung receptions and a fifth waiting for a slot at 55 seconds", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* linkSlackUser();
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      yield* runtime.drain;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const entered = yield* Queue.unbounded<void>();
      harness.script.current = () =>
        Queue.offer(entered, undefined).pipe(Effect.andThen(Effect.never));
      const ids: ChannelInputId[] = [];
      for (let index = 0; index < 5; index += 1) {
        const input = yield* gateway.ingest(
          slackInput("do: hung " + index, "hung-" + index, "root-" + index),
          slackContext,
        );
        ids.push(input.inputId);
      }
      yield* TestClock.adjust("20 seconds");
      yield* runtime.runPass;
      for (let index = 0; index < 4; index += 1) yield* Queue.take(entered);
      assert.strictEqual((yield* ledger.getInput(ids[4]!))?.snapshot.state, "accepted");
      yield* TestClock.adjust("34999 millis");
      assert.strictEqual(yield* runtime.expireOverdue, 0);
      for (const id of ids) assert.lengthOf(yield* replies(id), 0);
      yield* TestClock.adjust("1 millis");
      assert.strictEqual(yield* runtime.expireOverdue, 5);
      yield* runtime.settle(ids);
      assert.strictEqual(yield* runtime.expireOverdue, 0);
      for (const id of ids) {
        assert.deepStrictEqual(yield* replies(id), [
          {
            kind: "failure",
            state: "pending",
            text: "I couldn't read that: the model took too long to answer. Please send it again.",
          },
        ]);
        yield* failedInput(id);
      }
      harness.script.current = defaultScript;
      const next = yield* gateway.ingest(
        slackInput("hello", "after-timeout", "new-root"),
        slackContext,
      );
      yield* runtime.runPass;
      yield* runtime.settle([next.inputId]);
      assert.strictEqual((yield* ledger.getInput(next.inputId))?.snapshot.state, "replied");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("drops a late reception result after takeover without a second reply or task", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const reception = yield* ChannelReceptionService.ChannelReceptionService;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const gateway = yield* ChannelGateway.ChannelGateway;
      yield* claim(runtime.ownerToken);
      const entered = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      harness.script.current = (input) =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(finish)),
          Effect.andThen(defaultScript(input)),
        );
      const input = yield* gateway.ingest(goatInput("do: late job", "late"), rpcContext);
      yield* TestClock.adjust("20 seconds");
      // This reception belongs to an older runtime, outside the watchdog's in-flight map.
      const old = yield* reception
        .receive(input.inputId, runtime.ownerToken)
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* TestClock.adjust("35 seconds");
      assert.strictEqual(yield* runtime.expireOverdue, 1);
      yield* Deferred.succeed(finish, undefined);
      yield* Fiber.join(old);
      assert.lengthOf(yield* replies(input.inputId), 1);
      yield* failedInput(input.inputId);
      assert.lengthOf(
        (yield* ledger.listTasks({ ownerId: rpcContext.ownerId, limit: 10 })).tasks,
        0,
      );
      assert.lengthOf(harness.world.launches, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("takes over a reception begun immediately before expiry exactly once", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const gateway = yield* ChannelGateway.ChannelGateway;
      yield* claim(runtime.ownerToken);
      const input = yield* gateway.ingest(goatInput("hello", "takeover"), rpcContext);
      yield* TestClock.adjust("55 seconds");
      const receptionId = ChannelReceptionId.make("channel-reception:competing");
      yield* ledger.beginReception({
        owner: runtime.ownerToken,
        inputId: input.inputId,
        receptionId,
        readAt: DateTime.formatIso(yield* DateTime.now),
      });
      assert.strictEqual(yield* runtime.expireOverdue, 1);
      assert.isFalse(
        yield* ledger.completeReception({
          owner: runtime.ownerToken,
          inputId: input.inputId,
          receptionId,
          replyText: "Too late",
          decision: { replyText: "Too late", action: { type: "report_only" } },
          deliveries: [],
          now: DateTime.formatIso(yield* DateTime.now),
        }),
      );
      assert.strictEqual(yield* runtime.expireOverdue, 0);
      assert.lengthOf(yield* replies(input.inputId), 1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("sends the fixed Slack receipt without running an ordinary pass", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* linkSlackUser();
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const gateway = yield* ChannelGateway.ChannelGateway;
      yield* claim(runtime.ownerToken);
      const input = yield* gateway.ingest(slackInput("hello", "transport-deadline"), slackContext);
      yield* TestClock.adjust("55 seconds");
      assert.strictEqual(yield* runtime.expireOverdue, 1);
      yield* runtime.deliverReceipts;
      const sent = harness.slackSent.filter(
        (send) => send.message.inReplyToInputId === input.inputId,
      );
      assert.lengthOf(sent, 1);
      assert.deepStrictEqual(sent[0]?.message.destination, slackInput("", "").replyAddress);
      assert.strictEqual(sent[0]?.message.kind, "failure");
      assert.strictEqual(sent[0]?.message.mentionActorId, "U1");
      assert.strictEqual(
        sent[0]?.message.text,
        "I couldn't read that: the model took too long to answer. Please send it again.",
      );
      assert.strictEqual((yield* replies(input.inputId))[0]?.state, "delivered");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("rolls back the takeover if committing its failure reply fails", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const sql = yield* SqlClient.SqlClient;
      const runtime = yield* makeRuntime.pipe(
        Effect.provideService(ChannelLedger.ChannelLedger, {
          ...ledger,
          failReception: () =>
            Effect.fail(
              new ChannelLedger.ChannelLedgerError({
                reason: "persistence",
                detail: "injected receipt write failure",
              }),
            ),
        }),
      );
      yield* claim(runtime.ownerToken);
      const input = yield* gateway.ingest(goatInput("hello", "rollback"), rpcContext);
      const receptionId = ChannelReceptionId.make("channel-reception:before-rollback");
      yield* ledger.beginReception({
        owner: runtime.ownerToken,
        inputId: input.inputId,
        receptionId,
        readAt: DateTime.formatIso(yield* DateTime.now),
      });
      yield* TestClock.adjust("55 seconds");
      const result = yield* runtime.expireOverdue.pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
      const rows = yield* sql<{ readonly state: string; readonly reception_id: string }>`
        SELECT state, reception_id FROM channel_inbox WHERE input_id = ${input.inputId}
      `;
      assert.deepStrictEqual(rows, [{ state: "processing", reception_id: receptionId }]);
      assert.lengthOf(yield* replies(input.inputId), 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("the background deadline sends a receipt while the ordinary pass is blocked", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* linkSlackUser();
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const input = yield* gateway.ingest(slackInput("hello", "background-deadline"), slackContext);
      const blocked = yield* Deferred.make<void>();
      const sent = yield* Deferred.make<void>();
      let passes = 0;
      yield* Layer.build(
        ChannelRuntime.layerBackground.pipe(
          Layer.provide(
            Layer.succeed(ChannelRuntime.ChannelRuntime, {
              ...runtime,
              runPass: Effect.sync(() => {
                passes += 1;
              }).pipe(
                Effect.andThen(Deferred.succeed(blocked, undefined)),
                Effect.andThen(Effect.never),
              ),
              deliverReceipts: runtime.deliverReceipts.pipe(
                Effect.tap(() =>
                  harness.slackSent.some((send) => send.message.inReplyToInputId === input.inputId)
                    ? Deferred.succeed(sent, undefined)
                    : Effect.void,
                ),
              ),
            }),
          ),
        ),
      );
      yield* Deferred.await(blocked);
      yield* TestClock.adjust("54999 millis");
      assert.lengthOf(yield* replies(input.inputId), 0);
      yield* TestClock.adjust("1 millis");
      yield* Deferred.await(sent);
      assert.strictEqual(passes, 1);
      assert.strictEqual((yield* replies(input.inputId))[0]?.state, "delivered");
      assert.lengthOf(
        harness.slackSent.filter((send) => send.message.inReplyToInputId === input.inputId),
        1,
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("keeps a turn received while its receipt is pending or its delivery read fails", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const reception = yield* ChannelReceptionService.ChannelReceptionService;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const sql = yield* SqlClient.SqlClient;
      yield* claim(runtime.ownerToken);
      const input = yield* gateway.ingest(goatInput("do: wait for receipt", "gate"), rpcContext);
      yield* reception.receive(input.inputId, runtime.ownerToken);
      const task = yield* onlyTask;
      yield* sql`UPDATE channel_tasks SET task_json = json_set(task_json, '$.kind', 'turn')
        WHERE task_id = ${task.taskId}`;
      yield* runtime.runPass;
      assert.strictEqual((yield* ledger.getTask(task.taskId))?.task.status, "received");
      assert.lengthOf(harness.world.launches, 0);
      yield* sql`UPDATE channel_outbox SET state = 'pending' WHERE input_id = ${input.inputId}`;
      const failingSql = new Proxy(sql, {
        apply(target, thisArg, args) {
          if (
            Array.isArray(args[0]) &&
            args[0].join("").includes("SELECT 1 AS unsettled FROM channel_outbox")
          ) {
            return sql`SELECT * FROM missing_channel_receipts`;
          }
          return Reflect.apply(target, thisArg, args);
        },
      });
      const guarded = yield* makeRuntime.pipe(
        Effect.provideService(SqlClient.SqlClient, failingSql),
      );
      yield* TestClock.adjust("1 millis");
      yield* claim(guarded.ownerToken);
      yield* guarded.runPass;
      assert.strictEqual((yield* ledger.getTask(task.taskId))?.task.status, "received");
      assert.lengthOf(harness.world.launches, 0);
      assert.lengthOf(harness.world.sends, 0);
    }).pipe(Effect.provide(harness.layer));
  });
});
