import { assert, describe, it } from "@effect/vitest";
import { cuaDriverKey } from "@goat/provider-core/server/mcpSession";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import { call } from "./ComputerUseLeaseProxy.testkit.ts";
import {
  initialize,
  initialized,
  threadHarness,
  snapshot,
} from "./ComputerUseLeaseProxyThread.testkit.ts";
import { threadRouteFixture } from "./ComputerUseLeaseRoute.thread.testkit.ts";

describe("thread proxy settings recovery", () => {
  it.effect("bare waiting without a control reason uses a generic refusal", () =>
    Effect.gen(function* () {
      const h = yield* threadHarness();
      yield* h.push({ state: "waiting" });
      yield* h.send(call(1, "get_guide"));
      assert.deepInclude((yield* h.next).result, {
        content: [{ type: "text", text: "Computer use is not available for this turn." }],
      });
    }),
  );

  it.effect(
    "the same proxy follows real leases across disable and re-enable with an unchanged attachment and executes on the new driver",
    () =>
      Effect.gen(function* () {
        const f = yield* threadRouteFixture();
        const first = yield* f.attach();
        const s = yield* f.open();
        const h = yield* threadHarness({
          leaseUpdates: s.stream,
          reservation: (call) => f.leases.callReservation(f.threadId, call).pipe(Effect.orDie),
        });
        yield* h.update;
        const a = yield* h.started;
        yield* h.applied;
        yield* h.send(initialize);
        yield* h.next;
        yield* h.send(initialized);
        yield* f.disable;
        // This assertion also turns the old terminal bug into a deterministic red, rather than a blocked driver wait.
        assert.deepEqual(yield* h.update, {
          state: "control-ended",
          controlId: first.attachment.control.controlId,
          reason: "disabled",
        });
        assert.deepEqual(yield* h.update, { state: "waiting" });
        yield* Deferred.await(a.killed);
        yield* h.send(call(1, "get_guide"));
        const refused = yield* h.next;
        assert.deepInclude(refused.result?.structuredContent, { detail: "disabled" });
        assert.deepInclude(refused.result, {
          content: [
            {
              type: "text",
              text: "Computer use is turned off in settings. Re-enable it, then start a new turn or approval.",
            },
          ],
          isError: true,
        });
        yield* f.enable;
        const second = yield* f.attach();
        assert.deepEqual(second.descriptor, first.descriptor);
        assert.equal(cuaDriverKey(second.descriptor), cuaDriverKey(first.descriptor));
        assert.deepInclude(yield* h.update, {
          state: "active",
          controlId: second.attachment.control.controlId,
        });
        const b = yield* h.started;
        assert.notEqual(b.index, a.index);
        yield* h.applied;
        yield* h.applied;
        yield* h.send(call(2, "get_guide"));
        assert.equal((JSON.parse(yield* Queue.take(b.sent)) as { id: number }).id, 2);
        yield* Queue.offer(
          b.replies,
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            result: { content: [{ type: "text", text: "new control succeeded" }] },
          }),
        );
        assert.deepInclude(yield* h.next, {
          id: 2,
          result: { content: [{ type: "text", text: "new control succeeded" }] },
        });
      }).pipe(Effect.scoped),
  );

  it.effect.each(["active", "already-disabled"] as const)(
    "a control-ended disabled refusal from %s explains settings and a later control can execute",
    (initial) =>
      Effect.gen(function* () {
        const h = yield* threadHarness();
        if (initial === "active") {
          yield* h.push(snapshot("A"));
          const a = yield* h.started;
          yield* h.applied;
          yield* h.push({ state: "control-ended", controlId: "A", reason: "disabled" });
          yield* Deferred.await(a.killed);
        } else yield* h.push({ state: "control-ended", controlId: "A", reason: "disabled" });
        yield* h.push({ state: "waiting" });
        yield* h.send(call(1, "get_guide"));
        assert.deepInclude((yield* h.next).result, {
          structuredContent: { refused: "targetRefused", detail: "disabled" },
          content: [
            {
              type: "text",
              text: "Computer use is turned off in settings. Re-enable it, then start a new turn or approval.",
            },
          ],
        });
        yield* h.push(snapshot("B"));
        const b = yield* h.started;
        yield* h.send(call(2, "get_guide"));
        assert.equal((JSON.parse(yield* Queue.take(b.sent)) as { id: number }).id, 2);
      }),
  );
});
