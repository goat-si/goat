import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import { call } from "./ComputerUseLeaseProxy.testkit.ts";
import {
  initialize,
  initialized,
  request,
  serverInfo,
  snapshot,
  threadHarness,
  tools,
} from "./ComputerUseLeaseProxyThread.testkit.ts";

const work = (id: number) => call(id, "type_text", { pid: 42, window_id: 7, text: "fixture work" });

describe("thread lease proxy", () => {
  it.effect(
    "one stdio session interrupts A, refuses its unsent work, closes A before using B, and executes B without reinitialize",
    () =>
      Effect.gen(function* () {
        const targetGate = yield* Deferred.make<void>();
        const killGate = yield* Deferred.make<void>();
        const h = yield* threadHarness({ targetGate, killGate });
        yield* h.push(snapshot("A"));
        const a = yield* h.started;
        yield* h.applied;
        yield* h.send(initialize);
        assert.deepEqual((yield* h.next).result, serverInfo);
        yield* h.send(initialized);
        yield* Deferred.succeed(targetGate, undefined);
        yield* h.send(work(1));
        assert.equal((JSON.parse(yield* Queue.take(a.sent)) as { id: number }).id, 1);
        yield* h.target;
        yield* h.push({ state: "control-ended", controlId: "A", reason: "stopped" });
        yield* Deferred.await(a.killed);
        yield* h.send(work(2));
        assert.deepInclude((yield* h.next).result?.structuredContent, { detail: "stopped" });
        yield* h.push(snapshot("B", "1970-01-01T00:20:00.000Z"));
        assert.deepEqual(
          h.log.filter((l) => l.startsWith("start")),
          ["start 0"],
        );
        yield* Deferred.succeed(killGate, undefined);
        const interrupted = yield* h.next;
        assert.equal(interrupted.id, 1);
        assert.deepInclude(interrupted.result?.structuredContent, {
          code: "interrupted",
          effect: "unverifiable",
        });
        assert.equal((yield* h.closed).controlId, "A");
        const b = yield* h.started;
        yield* h.applied;
        yield* h.applied;
        assert.isBelow(h.log.indexOf("close A"), h.log.indexOf(`start ${b.index}`));
        yield* h.send(work(3));
        assert.equal((JSON.parse(yield* Queue.take(b.sent)) as { id: number }).id, 3);
        yield* Queue.offer(
          b.replies,
          JSON.stringify({ jsonrpc: "2.0", id: 3, result: { content: [] } }),
        );
        assert.equal((yield* h.next).id, 3);
        yield* h.send(request(9, "ping"));
        assert.equal((yield* h.next).id, 9);
      }),
  );

  it.effect(
    "waiting answers initialize, tools/list and ping with handshake-only children, and refuses execution",
    () =>
      Effect.gen(function* () {
        const h = yield* threadHarness();
        yield* h.push({ state: "waiting" });
        yield* h.send(initialize);
        assert.deepEqual((yield* h.next).result, serverInfo);
        yield* h.send(initialized);
        yield* h.send(request(101, "tools/list"));
        assert.deepEqual((yield* h.next).result, tools);
        yield* h.send(request(102, "ping"));
        assert.deepEqual((yield* h.next).result, {});
        yield* h.send(work(1));
        assert.deepInclude((yield* h.next).result?.structuredContent, { detail: "stopped" });
        assert.deepEqual(h.log, ["start 0", "closed 0", "start 1", "closed 1"]);
        yield* h.push(snapshot("B"));
        const b = yield* h.started;
        assert.equal(b.index, 0); // First handshake child, already closed.
        yield* h.started;
        const live = yield* h.started;
        yield* h.applied;
        yield* h.send(work(2));
        assert.equal((JSON.parse(yield* Queue.take(live.sent)) as { id: number }).id, 2);
      }),
  );

  it.effect(
    "late A target and agent reports retain A and an unsent A call is never replayed on B",
    () =>
      Effect.gen(function* () {
        const agentGate = yield* Deferred.make<void>();
        const h = yield* threadHarness({ agentGate });
        yield* h.push(snapshot("A"));
        const a = yield* h.started;
        yield* h.applied;
        yield* h.send(work(1));
        assert.equal(yield* h.target, "A");
        assert.equal((yield* h.agents).controlId, "A");
        yield* h.push(snapshot("B"));
        yield* Deferred.await(a.killed);
        yield* Deferred.succeed(agentGate, undefined);
        const refusal = yield* h.next;
        assert.equal(refusal.id, 1);
        assert.deepInclude(refusal.result?.structuredContent, { detail: "replaced" });
        assert.equal((yield* h.completedAgent).controlId, "A");
        const b = yield* h.started;
        yield* h.send(work(2));
        assert.equal((JSON.parse(yield* Queue.take(b.sent)) as { id: number }).id, 2);
        assert.equal(yield* h.target, "B");
        assert.equal((yield* h.agents).controlId, "B");
      }),
  );

  it.effect("A's deadline cannot expire B and B enforces its own independent deadline", () =>
    Effect.gen(function* () {
      const h = yield* threadHarness();
      yield* h.push(snapshot("A", "1970-01-01T00:01:00.000Z"));
      yield* h.started;
      yield* h.applied;
      yield* h.push(snapshot("B", "1970-01-01T00:02:00.000Z"));
      const b = yield* h.started;
      yield* h.applied;
      yield* h.applied;
      yield* TestClock.adjust("1 minute");
      yield* h.send(call(1, "get_guide"));
      assert.equal((JSON.parse(yield* Queue.take(b.sent)) as { id: number }).id, 1);
      yield* TestClock.adjust("1 minute");
      yield* Deferred.await(b.killed);
      assert.equal((yield* h.next).id, 1);
      yield* h.send(work(2));
      assert.deepInclude((yield* h.next).result?.structuredContent, { detail: "expired" });
    }),
  );

  it.effect.each(["unauthorized", "disabled"] as const)(
    "terminal %s refuses permanently even if a later snapshot arrives",
    (reason) =>
      Effect.gen(function* () {
        const h = yield* threadHarness();
        yield* h.push({ state: "ended", reason });
        yield* h.push(snapshot("B"));
        yield* h.send(work(1));
        assert.deepInclude((yield* h.next).result?.structuredContent, { detail: reason });
        assert.deepEqual(h.log, []);
      }),
  );
});

it.effect.each(["eof", "error"] as const)(
  "thread stream %s interrupts the driver as lost and permanently refuses execution",
  (ending) =>
    Effect.gen(function* () {
      const h = yield* threadHarness();
      yield* h.push(snapshot("A"));
      const a = yield* h.started;
      yield* h.applied;
      yield* h.send(call(1, "get_guide"));
      yield* Queue.take(a.sent);
      yield* ending === "eof" ? h.streamEnd : h.streamFail;
      yield* Deferred.await(a.killed);
      assert.deepInclude((yield* h.next).result?.structuredContent, {
        code: "interrupted",
        detail: "lost",
      });
      yield* h.send(work(2));
      assert.deepInclude((yield* h.next).result?.structuredContent, { detail: "lost" });
    }),
);

it.effect(
  "$/cancelRequest stays with A during its native close and does not cancel a request on B",
  () =>
    Effect.gen(function* () {
      const killGate = yield* Deferred.make<void>();
      const h = yield* threadHarness({ killGate });
      yield* h.push(snapshot("A"));
      const a = yield* h.started;
      yield* h.applied;
      yield* h.send(work(1));
      yield* Queue.take(a.sent);
      yield* h.push({ state: "control-ended", controlId: "A", reason: "stopped" });
      yield* Deferred.await(a.killed);
      yield* h.push(snapshot("B"));
      yield* h.send(
        JSON.stringify({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id: 1 } }),
      );
      yield* h.send(
        JSON.stringify({ jsonrpc: "2.0", id: "goat-thread-proxy:barrier", method: "ping" }),
      );
      assert.isDefined((yield* h.next).error);
      yield* Deferred.succeed(killGate, undefined);
      const b = yield* h.started;
      yield* h.send(work(2));
      assert.equal((JSON.parse(yield* Queue.take(b.sent)) as { id: number }).id, 2);
      yield* h.send(request(9, "ping"));
      assert.equal((yield* h.next).id, 9);
      yield* h.send(work(1));
      assert.equal((JSON.parse(yield* Queue.take(b.sent)) as { id: number }).id, 1);
    }),
);

it.effect.each(["paused", "idle"] as const)(
  "a first %s snapshot refuses work and a later activation uses the same control",
  (state) =>
    Effect.gen(function* () {
      const h = yield* threadHarness();
      yield* h.push(
        state === "paused"
          ? { ...snapshot("A"), state, reason: "private" }
          : { ...snapshot("A"), state },
      );
      yield* h.started;
      yield* h.applied;
      yield* h.send(work(1));
      assert.deepInclude((yield* h.next).result?.structuredContent, {
        detail: state === "paused" ? "private_mode" : "control_idle",
      });
      yield* h.push(snapshot("A"));
      const resumed = yield* h.started;
      yield* h.applied;
      yield* h.send(work(2));
      assert.equal((JSON.parse(yield* Queue.take(resumed.sent)) as { id: number }).id, 2);
    }),
);

it.effect(
  "a borrowed waiting list is rechecked by the next control and its newer answer is cached after Stop",
  () =>
    Effect.gen(function* () {
      const newerTools = {
        tools: [...tools.tools, { name: "list_apps", inputSchema: { type: "object" } }],
      };
      const h = yield* threadHarness({ toolsAt: (index) => (index < 2 ? tools : newerTools) });
      yield* h.send(initialize);
      yield* h.next;
      yield* h.send(initialized);
      yield* h.send(request(101, "tools/list"));
      assert.deepEqual((yield* h.next).result, tools);
      yield* h.push(snapshot("B"));
      yield* h.started;
      yield* h.started;
      yield* h.started;
      assert.equal((yield* h.next).method, "notifications/tools/list_changed");
      yield* h.send(request(102, "tools/list"));
      assert.deepEqual((yield* h.next).result, newerTools);
      yield* h.push({ state: "control-ended", controlId: "B", reason: "stopped" });
      yield* h.closed;
      yield* h.send(request(103, "tools/list"));
      assert.deepEqual((yield* h.next).result, newerTools);
      assert.equal(h.log.filter((line) => line.startsWith("start")).length, 3);
    }),
);
