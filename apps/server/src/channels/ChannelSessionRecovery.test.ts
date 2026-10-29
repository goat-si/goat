import { assert, describe, it } from "@effect/vitest";
import { ChannelGatewayError, ChannelReceptionId } from "@goat/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelBotTimeline from "./ChannelBotTimeline.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelReceptionService from "./ChannelReceptionService.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import * as ChannelSessionFirst from "./ChannelSessionFirst.ts";
import { CHANNEL_COPY } from "./channelCopy.ts";
import { taskIdFor } from "./channelIds.ts";
import {
  botMessages,
  defaultScript,
  goatInput,
  rpcContext,
  setupBot,
} from "./testkit/ChannelHarness.ts";
import { makeSessionHarness } from "./testkit/ChannelSessionHarness.ts";

const freshObserver = Layer.build(Layer.fresh(ChannelSessionFirst.layer)).pipe(
  Effect.map((context) => Context.get(context, ChannelSessionFirst.ChannelSessionFirst)),
);

describe("session receipt recovery", () => {
  it.effect.each(["before the first line", "after a sealed first line"] as const)(
    "restores a read mark lost to a crash after the claim: %s",
    (variant) => {
      const harness = makeSessionHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        const gateway = yield* ChannelGateway.ChannelGateway;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const ledger = yield* ChannelLedger.ChannelLedger;
        yield* runtime.drain;
        const input = yield* gateway.ingest(goatInput("Inspect the disk", variant), rpcContext);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const beforeCrash = yield* freshObserver.pipe(
              Effect.provideService(ChannelBotTimeline.ChannelBotTimeline, {
                record: () =>
                  Effect.fail(new ChannelGatewayError({ reason: "persistence_failed" })),
              }),
            );
            assert.isTrue(yield* beforeCrash.offer(input.inputId, runtime.ownerToken));
          }),
        );
        const inbound = Effect.map(botMessages, (records) =>
          records.messages.filter(
            (message) => message.role === "user" && message.channel?.inputId === input.inputId,
          ),
        );
        assert.isUndefined((yield* inbound)[0]?.channel?.readAt);
        const task = taskIdFor(input.inputId, 0);
        if (variant === "after a sealed first line") {
          yield* runtime.runPass;
          harness.assistant((yield* ledger.getTask(task))!.task, "Checking disk usage.\n", true);
        }
        const restarted = yield* freshObserver;
        yield* restarted.observe(runtime.ownerToken);
        yield* restarted.deadlines(runtime.ownerToken);
        yield* restarted.settle([input.inputId]);
        const copies = yield* inbound;
        assert.lengthOf(copies, 1);
        assert.strictEqual(
          copies[0]?.channel?.readAt,
          (yield* ledger.getInput(input.inputId))?.snapshot.readAt,
        );
        if (variant === "after a sealed first line") {
          yield* runtime.drain;
          const receipt = (yield* botMessages).messages.find(
            (message) => message.role === "assistant" && message.text === "Checking disk usage.",
          );
          assert.strictEqual(receipt?.channel?.inReplyToInputId, input.inputId);
          assert.strictEqual(receipt?.channel?.taskId, task);
        }
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("replays a sealed projection after a crash before the receipt commit", () => {
    const harness = makeSessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const sql = yield* SqlClient.SqlClient;
      const input = yield* gateway.ingest(
        goatInput("Inspect the disk", "projection-replay"),
        rpcContext,
      );
      yield* runtime.drain;
      const task = (yield* ledger.getTask(taskIdFor(input.inputId, 0)))!.task;
      const item = harness.assistant(task, "Checking disk usage.\nMore detail", true);
      const interrupted = yield* freshObserver.pipe(
        Effect.provideService(ChannelLedger.ChannelLedger, {
          ...ledger,
          commitSessionReceipt: () =>
            Effect.fail(
              new ChannelLedger.ChannelLedgerError({
                reason: "persistence",
                detail: "crash before receipt commit",
              }),
            ),
        }),
      );
      assert.strictEqual(
        (yield* interrupted.observe(runtime.ownerToken).pipe(Effect.result))._tag,
        "Failure",
      );
      assert.isUndefined((yield* ledger.getInput(input.inputId))?.snapshot.reply);
      const restarted = yield* freshObserver;
      yield* restarted.observe(runtime.ownerToken);
      yield* runtime.settle([input.inputId]);
      assert.strictEqual(
        (yield* ledger.getInput(input.inputId))?.snapshot.reply?.text,
        "Checking disk usage.",
      );
      assert.deepStrictEqual(
        yield* sql`SELECT source, run_id, turn_item_id FROM channel_session_receipts
        WHERE input_id = ${input.inputId}`,
        [{ source: "session", run_id: task.worker!.runId, turn_item_id: item.id }],
      );
      assert.deepStrictEqual((yield* ledger.getInput(input.inputId))?.snapshot.taskIds, [
        task.taskId,
      ]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("regenerates acknowledgment after a crash between takeover and receipt commit", () => {
    const harness = makeSessionHarness();
    const modes: string[] = [];
    harness.script.current = (input) => {
      modes.push(input.mode);
      return defaultScript(input);
    };
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const ledger = yield* ChannelLedger.ChannelLedger;
      yield* runtime.drain;
      const input = yield* gateway.ingest(goatInput("Inspect the disk", "ack-replay"), rpcContext);
      const expectedReceptionId = ChannelReceptionId.make("channel-session:" + input.inputId);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const beforeCrash = yield* freshObserver;
          assert.isTrue(yield* beforeCrash.offer(input.inputId, runtime.ownerToken));
          assert.isTrue(
            yield* ledger.takeSessionAcknowledgment({
              owner: runtime.ownerToken,
              inputId: input.inputId,
              expectedReceptionId,
              receptionId: ChannelReceptionId.make(
                "channel-session-ack:" + input.inputId + ":crash",
              ),
            }),
          );
        }),
      );
      yield* TestClock.adjust("20 seconds");
      const restarted = yield* freshObserver;
      yield* restarted.deadlines(runtime.ownerToken);
      yield* restarted.settle([input.inputId]);
      assert.deepStrictEqual(modes, ["task_event"]);
      assert.isDefined((yield* ledger.getInput(input.inputId))?.snapshot.reply);
      const sql = yield* SqlClient.SqlClient;
      assert.deepStrictEqual(
        yield* sql`SELECT source FROM channel_session_receipts WHERE input_id = ${input.inputId}`,
        [{ source: "fallback" }],
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("ordinary reception cannot take either durable session claim", () => {
    const harness = makeSessionHarness();
    let calls = 0;
    harness.script.current = (input) => {
      calls += 1;
      return defaultScript(input);
    };
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const reception = yield* ChannelReceptionService.ChannelReceptionService;
      const input = yield* gateway.ingest(goatInput("Inspect disk", "claim-race"), rpcContext);
      yield* runtime.drain;
      const initial = (yield* ledger.getInput(input.inputId))!.snapshot.receptionId!;
      yield* reception.receive(input.inputId, runtime.ownerToken);
      assert.deepStrictEqual(yield* ledger.listReceivableInputs(100), []);
      assert.strictEqual((yield* ledger.getInput(input.inputId))!.snapshot.receptionId, initial);
      const ack = ChannelReceptionId.make("channel-session-ack:" + input.inputId + ":race");
      yield* ledger.takeSessionAcknowledgment({
        owner: runtime.ownerToken,
        inputId: input.inputId,
        expectedReceptionId: initial,
        receptionId: ack,
      });
      yield* reception.receive(input.inputId, runtime.ownerToken);
      assert.strictEqual((yield* ledger.getInput(input.inputId))!.snapshot.receptionId, ack);
      assert.deepStrictEqual(yield* ledger.listReceivableInputs(100), []);
      assert.strictEqual(calls, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "hung acknowledgment commits the session fixed line at 55 seconds and ignores late text",
    () => {
      const harness = makeSessionHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        const entered = yield* Deferred.make<void>();
        let calls = 0;
        harness.script.current = () => {
          calls += 1;
          return Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never));
        };
        const gateway = yield* ChannelGateway.ChannelGateway;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const ledger = yield* ChannelLedger.ChannelLedger;
        const sql = yield* SqlClient.SqlClient;
        const input = yield* gateway.ingest(goatInput("Inspect disk", "hung-ack"), rpcContext);
        yield* runtime.drain;
        const task = (yield* ledger.getTask(taskIdFor(input.inputId, 0)))!.task;
        yield* TestClock.adjust("19999 millis");
        assert.strictEqual(calls, 0);
        yield* TestClock.adjust("1 millis");
        yield* Deferred.await(entered);
        yield* TestClock.adjust("34999 millis");
        assert.isUndefined((yield* ledger.getInput(input.inputId))?.snapshot.reply);
        yield* TestClock.adjust("1 millis");
        yield* runtime.expireOverdue;
        yield* runtime.settle([input.inputId]);
        assert.strictEqual(
          (yield* ledger.getInput(input.inputId))?.snapshot.reply?.text,
          CHANNEL_COPY.sessionWorking,
        );
        assert.strictEqual((yield* ledger.getTask(task.taskId))?.task.status, "running");
        harness.assistant(task, "A late first line.\n", true);
        yield* runtime.runPass;
        yield* runtime.settle([input.inputId]);
        assert.strictEqual(calls, 1);
        assert.deepStrictEqual(
          yield* sql`SELECT source, text FROM channel_session_receipts WHERE input_id = ${input.inputId}`,
          [{ source: "fixed", text: CHANNEL_COPY.sessionWorking }],
        );
        assert.lengthOf(
          yield* sql`SELECT delivery_id FROM channel_outbox WHERE cause_key = ${"reply:" + input.inputId}`,
          1,
        );
        assert.strictEqual(DateTime.toEpochMillis(yield* DateTime.now), 55_000);
      }).pipe(Effect.provide(harness.layer));
    },
  );
});
