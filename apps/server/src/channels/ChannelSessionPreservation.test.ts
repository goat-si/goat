import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelReceptionService from "./ChannelReceptionService.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import { deliveryIdFor, taskIdFor } from "./channelIds.ts";
import { makeSessionHarness } from "./testkit/ChannelSessionHarness.ts";
import {
  defaultScript,
  goatInput,
  rpcContext,
  setupBot,
  linkSlackUser,
  slackInput,
  slackContext,
} from "./testkit/ChannelHarness.ts";

describe("session-first reception controls", () => {
  it.effect("retains reception when the requester is at capacity in other conversations", () => {
    const harness = makeSessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* linkSlackUser();
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const reception = yield* ChannelReceptionService.ChannelReceptionService;
      const sql = yield* SqlClient.SqlClient;
      yield* runtime.drain;
      for (let index = 0; index < 4; index += 1) {
        const input = yield* gateway.ingest(
          slackInput("do: inspect disk", "capacity-" + index, "root-" + index),
          slackContext,
        );
        yield* reception.receive(input.inputId, runtime.ownerToken);
        yield* sql`UPDATE channel_tasks SET status = 'running', task_json = json_set(task_json, '$.status', 'running')
          WHERE task_id = ${taskIdFor(input.inputId, 0)}`;
      }
      assert.strictEqual(
        yield* ledger.countBusyTasks({
          ownerId: rpcContext.ownerId,
          principalId: rpcContext.principalId,
        }),
        4,
      );
      const input = yield* gateway.ingest(goatInput("hello", "at-capacity"), rpcContext);
      yield* runtime.drain;
      assert.match(
        (yield* ledger.getInput(input.inputId))!.snapshot.receptionId!,
        /^channel-reception:/u,
      );
      assert.lengthOf(harness.world.launches, 0);
    }).pipe(Effect.provide(harness.layer));
  });
  it.effect("a path-c driver retains ordinary reception", () => {
    const harness = makeSessionHarness({ driver: "opencode" });
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
      const input = yield* gateway.ingest(goatInput("hello", "path-c"), rpcContext);
      yield* runtime.drain;
      assert.strictEqual(calls, 1);
      assert.match(
        (yield* ledger.getInput(input.inputId))!.snapshot.receptionId!,
        /^channel-reception:/u,
      );
      assert.lengthOf(harness.world.launches, 0);
    }).pipe(Effect.provide(harness.layer));
  });
  it.effect.each([
    "received",
    "dispatching",
    "running",
    "waiting_input",
    "awaiting delivery",
  ] as const)("keeps reception when the conversation has work %s", (status) => {
    const harness = makeSessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const reception = yield* ChannelReceptionService.ChannelReceptionService;
      const sql = yield* SqlClient.SqlClient;
      yield* runtime.drain;
      const first = yield* gateway.ingest(goatInput("do: inspect disk", "open-work"), rpcContext);
      yield* reception.receive(first.inputId, runtime.ownerToken);
      const task = yield* ledger.getTask(taskIdFor(first.inputId, 0));
      assert.isDefined(task);
      const state = status === "awaiting delivery" ? "completed" : status;
      yield* sql`UPDATE channel_tasks SET status = ${state}, task_json = json_set(task_json, '$.status', ${state})
          WHERE task_id = ${task!.task.taskId}`;
      if (status === "awaiting delivery") {
        const causeKey = "outcome-before-receipt";
        const deliveryId = deliveryIdFor(causeKey);
        yield* ledger.enqueueDeliveries(
          [
            {
              deliveryId,
              causeKey,
              taskId: task!.task.taskId,
              message: {
                deliveryId,
                destination: task!.task.originAddress,
                kind: "result",
                text: "Result",
              },
            },
          ],
          DateTime.formatIso(yield* DateTime.now),
        );
      }
      let calls = 0;
      harness.script.current = (input) => {
        if (input.mode === "input") calls += 1;
        return defaultScript(input);
      };
      const second = yield* gateway.ingest(goatInput("What is pending?", "control"), rpcContext);
      yield* runtime.runPass;
      yield* runtime.settle([second.inputId]);
      assert.strictEqual(calls, 1);
      assert.match(
        (yield* ledger.getInput(second.inputId))!.snapshot.receptionId!,
        /^channel-reception:/u,
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect.each(["answer", "report"] as const)(
    "keeps explicit %s inputs on reception",
    (intent) => {
      const harness = makeSessionHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        const gateway = yield* ChannelGateway.ChannelGateway;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const ledger = yield* ChannelLedger.ChannelLedger;
        if (intent === "report") {
          const result = yield* gateway
            .ingest({ ...goatInput("hello", intent), intent }, rpcContext)
            .pipe(Effect.result);
          assert.strictEqual(result._tag, "Failure");
          if (result._tag === "Failure") assert.strictEqual(result.failure.reason, "invalid_input");
          assert.lengthOf(harness.world.launches, 0);
          return;
        }
        const input = yield* gateway.ingest({ ...goatInput("hello", intent), intent }, rpcContext);
        yield* runtime.drain;
        assert.match(
          (yield* ledger.getInput(input.inputId))!.snapshot.receptionId!,
          /^channel-reception:/u,
        );
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("a busy bound session keeps reception even with no open task", () => {
    const harness = makeSessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const sql = yield* SqlClient.SqlClient;
      const first = yield* gateway.ingest(goatInput("Inspect disk", "busy-first"), rpcContext);
      yield* runtime.drain;
      const task = (yield* ledger.getTask(taskIdFor(first.inputId, 0)))!.task;
      harness.assistant(task, "Checking.\n", true);
      yield* runtime.runPass;
      yield* runtime.settle([first.inputId]);
      yield* sql`UPDATE channel_tasks SET status = 'completed', task_json = json_set(task_json, '$.status', 'completed')
        WHERE task_id = ${task.taskId}`;
      const second = yield* gateway.ingest(
        goatInput("What is pending?", "busy-second"),
        rpcContext,
      );
      yield* runtime.drain;
      assert.match(
        (yield* ledger.getInput(second.inputId))!.snapshot.receptionId!,
        /^channel-reception:/u,
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("a requester without orchestration admission stays on reception", () => {
    const harness = makeSessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const input = yield* gateway.ingest(goatInput("hello", "read-only"), {
        ...rpcContext,
        grantedScopes: ["orchestration:read"],
      });
      yield* runtime.drain;
      assert.match(
        (yield* ledger.getInput(input.inputId))!.snapshot.receptionId!,
        /^channel-reception:/u,
      );
      assert.lengthOf(harness.world.launches, 0);
    }).pipe(Effect.provide(harness.layer));
  });
});
