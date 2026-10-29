import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServerSettings from "../serverSettings.ts";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelReceptionService from "./ChannelReceptionService.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import * as ChannelDispatcher from "./ChannelDispatcher.ts";
import * as ChannelWorkerReports from "./ChannelWorkerReports.ts";
import { deliveryIdFor } from "./channelIds.ts";
import { taskIdFor } from "./channelIds.ts";
import { makeSessionHarness } from "./testkit/ChannelSessionHarness.ts";
import {
  defaultScript,
  goatInput,
  makeHarness,
  rpcContext,
  setupBot,
  makeRuntime,
  botMessages,
  modelSelection,
} from "./testkit/ChannelHarness.ts";

describe("session first receipts", () => {
  it.effect("uses the dispatch fallback binding when the configured bot account is missing", () => {
    const harness = makeHarness({
      botWorkspace: true,
      providerInstances: [{ instanceId: "missing", missing: true }, { instanceId: "codex" }],
      settingsLayer: ServerSettings.layerTest({
        textGenerationModelSelection: modelSelection,
        goatBotModelSelection: {
          instanceId: ProviderInstanceId.make("missing"),
          model: "unavailable",
        },
        defaultRuntimeMode: "full-access",
      }).pipe(Layer.orDie),
    });
    let calls = 0;
    harness.script.current = (input) => {
      calls += 1;
      return defaultScript(input);
    };
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      yield* gateway.ingest(goatInput("Inspect disk", "fallback-binding"), rpcContext);
      yield* runtime.drain;
      assert.strictEqual(calls, 0);
      assert.strictEqual(harness.world.launches[0]?.modelSelection.instanceId, "codex");
    }).pipe(Effect.provide(harness.layer));
  });
  it.effect.each(["same item", "separate item", "fallback"] as const)(
    "direct answer keeps exactly the intended messages: %s",
    (variant) => {
      const harness = makeSessionHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        const gateway = yield* ChannelGateway.ChannelGateway;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const ledger = yield* ChannelLedger.ChannelLedger;
        const input = yield* gateway.ingest(
          goatInput("What is two plus two?", variant),
          rpcContext,
        );
        yield* runtime.drain;
        const stored = yield* ledger.getTask(taskIdFor(input.inputId, 0));
        assert.isDefined(stored?.task.worker);
        const task = stored!.task;
        if (variant === "fallback") {
          yield* TestClock.adjust("20 seconds");
          yield* runtime.expireOverdue;
          yield* runtime.settle([input.inputId]);
        } else {
          harness.assistant(task, variant === "same item" ? "Four." : "Checking.\n", true);
          if (variant === "same item") harness.assistant(task, "Four.");
          yield* runtime.runPass;
          yield* runtime.settle([input.inputId]);
          assert.strictEqual(
            (yield* ledger.getInput(input.inputId))?.snapshot.reply?.text,
            variant === "same item" ? "Four." : "Checking.",
          );
        }
        if (variant !== "same item") harness.assistant(task, "Four.", false, 1);
        harness.world.setStatus(task.worker!.threadId, 1, "completed");
        yield* runtime.drain;
        const { messages } = yield* botMessages;
        const answers = messages.filter((message) => message.text === "Four.");
        assert.lengthOf(answers, 1);
        assert.isFalse(messages.some((message) => message.text === "Done."));
        const page = yield* ledger.outcomeDeliveries([task.taskId]);
        assert.strictEqual(page.get(task.taskId), "delivered");
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("a run reconciled before its receipt commits still sends its answer once", () => {
    const harness = makeSessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      const input = yield* gateway.ingest(goatInput("What is two plus two?", "race"), rpcContext);
      yield* runtime.drain;
      const task = (yield* ledger.getTask(taskIdFor(input.inputId, 0)))!.task;
      harness.assistant(task, "Four.");
      harness.world.setStatus(task.worker!.threadId, 1, "completed");
      // The worker pass sees the finished run before the observer commits its first line.
      yield* reports.reconcile(runtime.ownerToken);
      assert.strictEqual((yield* ledger.getTask(task.taskId))?.task.status, "running");
      yield* runtime.drain;
      yield* runtime.settle([input.inputId]);
      yield* runtime.drain;
      const { messages } = yield* botMessages;
      assert.lengthOf(
        messages.filter((message) => message.text === "Four."),
        1,
      );
      assert.isFalse(messages.some((message) => message.text === "Done."));
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("a claim before dispatch survives a runtime restart as one turn", () => {
    const harness = makeHarness({ botWorkspace: true });
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const dispatcher = yield* ChannelDispatcher.ChannelDispatcher;
      const runtime = yield* makeRuntime.pipe(
        Effect.provideService(ChannelDispatcher.ChannelDispatcher, {
          ...dispatcher,
          dispatch: () => Effect.void,
        }),
      );
      const ledger = yield* ChannelLedger.ChannelLedger;
      const input = yield* gateway.ingest(goatInput("Inspect this machine", "restart"), rpcContext);
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* ledger.claimOwnership({ token: runtime.ownerToken, now, staleBefore: now });
      yield* runtime.runPass;
      yield* runtime.settle([input.inputId]);
      assert.strictEqual(
        (yield* ledger.getInput(input.inputId))?.snapshot.receptionId,
        "channel-session:" + input.inputId,
      );
      assert.lengthOf(harness.world.launches, 0);
      assert.strictEqual(
        (yield* ledger.getTask(taskIdFor(input.inputId, 0)))?.task.status,
        "received",
      );
      const restarted = yield* makeRuntime;
      yield* TestClock.adjust("31 seconds");
      yield* restarted.drain;
      assert.strictEqual((yield* ledger.getTask(taskIdFor(input.inputId, 0)))?.task.kind, "turn");
      assert.lengthOf(harness.world.launches, 1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("a silent session gets acknowledgment-only reception at 20 seconds", () => {
    const harness = makeHarness({ botWorkspace: true });
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
      const input = yield* gateway.ingest(goatInput("Inspect this machine", "silent"), rpcContext);
      yield* runtime.drain;
      assert.isUndefined((yield* ledger.getInput(input.inputId))?.snapshot.reply);
      yield* TestClock.adjust("20 seconds");
      yield* runtime.expireOverdue;
      yield* runtime.settle([input.inputId]);
      assert.deepStrictEqual(modes, ["task_event"]);
      assert.isDefined((yield* ledger.getInput(input.inputId))?.snapshot.reply);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("offers an idle per-run session the request without calling reception", () => {
    const harness = makeHarness({ botWorkspace: true });
    let calls = 0;
    harness.script.current = (input) => {
      calls += 1;
      return defaultScript(input);
    };
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      yield* gateway.ingest(goatInput("What is two plus two?", "session-first"), rpcContext);
      yield* runtime.drain;
      assert.strictEqual(calls, 0);
      assert.lengthOf(harness.world.launches, 1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("holds task-only outbox rows when their origin receipt is missing", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const reception = yield* ChannelReceptionService.ChannelReceptionService;
      const sql = yield* SqlClient.SqlClient;
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* ledger.claimOwnership({ token: "test", now, staleBefore: now });
      const input = yield* gateway.ingest(goatInput("do: inspect disk", "missing"), rpcContext);
      yield* reception.receive(input.inputId, "test");
      yield* sql`DELETE FROM channel_outbox WHERE cause_key = ${"reply:" + input.inputId}`;
      const claimed = yield* ledger.claimDueDeliveries({ owner: "test", now, limit: 100 });
      assert.lengthOf(claimed, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("a late retry result cannot reopen a terminal receipt", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const reception = yield* ChannelReceptionService.ChannelReceptionService;
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* ledger.claimOwnership({ token: "test", now, staleBefore: now });
      const input = yield* gateway.ingest(goatInput("hello", "late"), rpcContext);
      yield* reception.receive(input.inputId, "test");
      yield* ledger.claimDueDeliveries({ owner: "test", now, limit: 100 });
      const deliveryId = deliveryIdFor("reply:" + input.inputId);
      yield* ledger.recordDelivery({
        owner: "test",
        deliveryId,
        now,
        outcome: { type: "ambiguous", errorCode: "deadline" },
      });
      yield* ledger.recordDelivery({
        owner: "test",
        deliveryId,
        now,
        outcome: { type: "retry", at: now, errorCode: "late" },
      });
      assert.strictEqual(yield* ledger.getDeliveryState(deliveryId), "ambiguous");
    }).pipe(Effect.provide(harness.layer));
  });
});
