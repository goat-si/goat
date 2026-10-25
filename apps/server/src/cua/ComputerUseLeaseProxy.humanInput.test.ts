import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import { runMigrations } from "../persistence/Migrations.ts";
import { foregroundProxy, foregroundProxyLayer } from "./ComputerUseForeground.testkit.ts";

import {
  active,
  call,
  CONTROL,
  harness,
  type ToolAnswer,
} from "./ComputerUseLeaseProxy.testkit.ts";

describe("ComputerUseLeaseProxy telling a person's input from the agent's", () => {
  it.effect.each(["pointer", "keyboard"] as const)(
    "a capable helper's accepted human %s input pauses and revokes foreground without restoring focus",
    (source) =>
      Effect.gen(function* () {
        yield* runMigrations();
        const thread = ThreadId.make("thread:foreground-human");
        const { h, leases, control, grant, humanReport } = yield* foregroundProxy(thread);
        // A different input kind cannot be explained by the still-running agent action.
        const original = call(1, source === "keyboard" ? "click" : "type_text", {
          pid: 42,
          window_id: 7,
          ...(source === "keyboard" ? { x: 1, y: 1 } : { text: "approved foreground work" }),
          delivery_mode: "foreground",
        });
        yield* h.send(original);
        const observed = yield* Effect.raceFirst(
          h.nextDispatch.pipe(Effect.map(({ message }) => ({ kind: "dispatch", message }))),
          h.nextToProvider.pipe(Effect.map((message) => ({ kind: "answer", message }))),
        );
        assert.equal(observed.kind, "dispatch");
        assert.deepEqual(observed.message, JSON.parse(original));
        assert.equal((yield* h.nextReservation).action, "reserve");
        assert.equal((yield* h.nextValidation).action, "validate");
        assert.equal(yield* h.agentCall, "start 1");
        yield* h.hid(source);
        assert.equal(yield* h.person, source);
        assert.equal(yield* humanReport, "paused");
        yield* h.killed;
        const cancellation = yield* h.nextDispatch;
        assert.equal(cancellation.message.method, "notifications/cancelled");
        assert.equal((yield* h.nextReservation).action, "close");
        assert.equal((yield* h.nextToProvider).id, 1);
        assert.equal(yield* h.agentCall, "end 1");
        assert.deepEqual(yield* leases.controlState(thread, control.controlId), {
          _tag: "paused",
          reason: "human_input",
        });
        assert.isFalse(yield* leases.foregroundAvailable(thread, "Check the build status"));
        yield* h.send(
          call(2, "type_text", {
            pid: 42,
            window_id: 7,
            text: "while paused",
            delivery_mode: "foreground",
          }),
        );
        const paused = yield* h.nextToProvider;
        assert.equal(paused.id, 2);
        assert.deepInclude((paused.result as { structuredContent: object }).structuredContent, {
          detail: "waiting_for_human",
        });
        yield* leases.resume;
        yield* h.restarted;
        yield* leases.approveForeground(grant, yield* leases.foregroundApprovalEpoch);
        yield* h.send(
          call(3, "type_text", {
            pid: 42,
            window_id: 7,
            text: "old grant after handback",
            delivery_mode: "foreground",
          }),
        );
        const refused = yield* h.nextToProvider;
        assert.equal(refused.id, 3);
        assert.deepInclude((refused.result as { structuredContent: object }).structuredContent, {
          detail: "foreground_not_approved",
        });
        const outbound = (yield* Effect.forEach(h.drivers, (driver) =>
          Queue.size(driver.toDriver).pipe(
            Effect.flatMap((count) => Queue.takeN(driver.toDriver, count)),
          ),
        ))
          .flat()
          .map((line) => JSON.parse(line));
        assert.deepEqual(outbound, [JSON.parse(original), cancellation.message]);
        yield* h.send(call(4, "type_text", { pid: 42, window_id: 7, text: "background" }));
        assert.equal((yield* h.nextDispatch).message.id, 4);
        assert.equal((yield* h.nextReservation).action, "reserve");
        assert.equal((yield* h.nextValidation).action, "validate");
        yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: 4, result: { content: [] } }));
        assert.equal((yield* h.nextToProvider).id, 4);
        assert.equal((yield* h.nextReservation).action, "release");
      }).pipe(Effect.provide(foregroundProxyLayer)),
  );

  it.effect("a person's key during the agent's own click reaches the server", () =>
    Effect.gen(function* () {
      const h = yield* harness({ humanInput: true });
      yield* h.push(active());
      yield* h.send(call(1, "click", { pid: 4, window_id: 9, x: 1, y: 1 }));
      assert.equal((yield* h.nextToDriver).id, 1);
      // A click posts pointer events; a keyboard event while it runs is someone else's.
      yield* h.hid("keyboard");
      yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } }));
      yield* h.nextToProvider;
      yield* TestClock.adjust(2_000);
      yield* h.hid("pointer");
      assert.equal(yield* h.person, "keyboard");
    }),
  );

  it.effect("a call reaches the driver only after the server has its start", () =>
    Effect.gen(function* () {
      const agentInputGate = yield* Deferred.make<void>();
      const h = yield* harness({ humanInput: true, agentInputGate });
      yield* h.push(active());
      yield* h.send(call(1, "click", { pid: 4, window_id: 9, x: 1, y: 1 }));
      assert.equal(yield* h.agentCall, "start 1");
      // Another agent's helper may see this click's events: the server must already know it.
      assert.equal(yield* h.driverQueued, 0);
      yield* Deferred.succeed(agentInputGate, undefined);
      assert.equal((yield* h.nextToDriver).id, 1);
      yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } }));
      yield* h.nextToProvider;
      assert.equal(yield* h.agentCall, "end 1");
    }),
  );

  it.effect("a call whose start report a pause overtook never reaches the next driver", () =>
    Effect.gen(function* () {
      const agentInputGate = yield* Deferred.make<void>();
      const h = yield* harness({ humanInput: true, agentInputGate });
      yield* h.push(active());
      yield* h.send(call(1, "click", { pid: 4, window_id: 9, x: 1, y: 1 }));
      assert.equal(yield* h.agentCall, "start 1");
      yield* h.push({ state: "paused", controlId: CONTROL, reason: "takeover" });
      yield* h.killed;
      yield* h.push(active());
      yield* h.restarted;
      yield* Deferred.succeed(agentInputGate, undefined);
      const answer = (yield* h.nextToProvider) as unknown as ToolAnswer;
      assert.equal(answer.id, 1);
      assert.deepInclude(answer.result.structuredContent, { detail: "waiting_for_human" });
      assert.notProperty(answer.result.structuredContent, "effect");
      // Its start is closed again, after the start, so it hides nobody's input.
      assert.equal(yield* h.agentCall, "end 1");
      yield* h.send(call(2, "get_window_state", { pid: 4, window_id: 9 }));
      assert.equal((yield* h.nextToDriver).id, 2);
    }),
  );
});
