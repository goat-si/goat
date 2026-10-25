import { TurnItemId, type ComputerUseLeaseThreadUpdate } from "@goat/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scheduler from "effect/Scheduler";
import * as Stream from "effect/Stream";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import { runThreadLeaseProxy } from "./ComputerUseLeaseProxyThread.ts";
import { linuxScreenshotPolicy } from "./ComputerUseLinuxScreenshots.ts";
import { CROPPED_CAPTURE } from "./linuxHelper/windowCapture.ts";
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
    "a handshake answer replayed while waiting follows the Linux screenshot rule (#1677)",
    () =>
      Effect.gen(function* () {
        const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg";
        const h = yield* threadHarness({
          screenshots: linuxScreenshotPolicy({ route: "refused", reason: CROPPED_CAPTURE }),
          toolsAt: () => ({ tools: [{ name: image, inputSchema: { type: "object" } }] }),
        });
        yield* h.push({ state: "waiting" });
        yield* h.send(initialize);
        yield* h.next;
        yield* h.send(initialized);
        yield* h.send(request(101, "tools/list"));
        const answer = JSON.stringify(yield* h.next);
        assert.notInclude(answer, "iVBORw0KGgo");
        assert.include(answer, CROPPED_CAPTURE);
      }),
  );

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

it.effect.each(["shared", "narrowing", "foreground", "stop", "replacement", "terminal"] as const)(
  "receipt fences prevent dispatch across the first scheduler yield after %s",
  (change) => {
    let boundary = false;
    let gate: Deferred.Deferred<void>;
    class ReceiptScheduler extends Scheduler.MixedScheduler {
      override shouldYield(fiber: Parameters<Scheduler.MixedScheduler["shouldYield"]>[0]) {
        if (boundary) {
          boundary = false;
          // Resume admission only AFTER the next legal yield, never from the update getter.
          queueMicrotask(() => Deferred.doneUnsafe(gate, Exit.void));
          return true;
        }
        return super.shouldYield(fiber);
      }
    }
    return Effect.gen(function* () {
      const input = yield* Queue.unbounded<string>();
      const updates = yield* Queue.unbounded<ComputerUseLeaseThreadUpdate>();
      const applied = yield* Queue.unbounded();
      const outcome = yield* Queue.unbounded<string>();
      const reserved = yield* Deferred.make<void>();
      gate = yield* Deferred.make<void>();
      const expiresAt = "2100-01-01T00:00:00Z";
      const initial = {
        ...snapshot("A", expiresAt),
        foreground: [
          {
            handoffId: TurnItemId.make("fg"),
            purpose: "fixture",
            target: "desktop" as const,
            expiresAtMillis: 4102444800000,
          },
        ],
      };
      yield* runThreadLeaseProxy({
        connectionId: "receipt-test",
        bundleIds: true,
        input: Stream.fromQueue(input),
        leaseUpdates: Stream.fromQueue(updates),
        output: (line) => Queue.offer(outcome, line).pipe(Effect.asVoid),
        onLeaseUpdateApplied: (update) => Queue.offer(applied, update).pipe(Effect.asVoid),
        startDriver: Effect.succeed({
          send: () => Queue.offer(outcome, "DISPATCHED").pipe(Effect.asVoid),
          lines: Stream.never,
          kill: Effect.void,
        }),
        revokeSessions: () => Effect.void,
        reports: () => ({}),
        reservation: (reservation) =>
          reservation.action === "reserve"
            ? Deferred.succeed(reserved, undefined).pipe(
                Effect.andThen(Deferred.await(gate)),
                Effect.as({
                  status: "admitted" as const,
                  reservationId: "ticket",
                  permissions: { validUntilMillis: 4102444800000 },
                }),
              )
            : Effect.succeed({ status: "released" as const }),
      }).pipe(Effect.scoped, Effect.forkChild);
      yield* Queue.offer(updates, initial);
      yield* Queue.take(applied);
      yield* Queue.offer(input, call(1, "bring_to_front", { pid: 1, window_id: 2 }));
      yield* Deferred.await(reserved);
      const restriction: ComputerUseLeaseThreadUpdate =
        change === "stop"
          ? {
              state: "control-ended",
              controlId: "A",
              get reason() {
                boundary = true;
                return "stopped" as const;
              },
            }
          : change === "terminal"
            ? {
                state: "ended",
                get reason() {
                  boundary = true;
                  return "disabled" as const;
                },
              }
            : {
                ...initial,
                ...(change === "shared"
                  ? { shared: true }
                  : change === "narrowing"
                    ? { apps: [] }
                    : change === "replacement"
                      ? { controlId: "B" }
                      : { foreground: [] }),
                get expiresAt() {
                  boundary = true;
                  return expiresAt;
                },
              };
      yield* Queue.offer(updates, restriction);
      const result = yield* Queue.take(outcome);
      assert.notEqual(result, "DISPATCHED");
      const expected = {
        shared: "screen_shared",
        narrowing: "app_not_approved",
        foreground: "foreground_not_approved",
        stop: "stopped",
        replacement: "replaced",
        terminal: "disabled",
      }[change];
      assert.equal(
        (JSON.parse(result) as { result: { structuredContent: { detail: string } } }).result
          .structuredContent.detail,
        expected,
      );
    }).pipe(Effect.provideService(Scheduler.Scheduler, new ReceiptScheduler()));
  },
);

it.effect(
  "client replies cannot cross controls even when A and B issue the same server request id",
  () =>
    Effect.gen(function* () {
      const h = yield* threadHarness();
      yield* h.push(snapshot("A"));
      const a = yield* h.started;
      yield* h.applied;
      const serverRequest = JSON.stringify({ jsonrpc: "2.0", id: 900, method: "roots/list" });
      yield* Queue.offer(a.replies, serverRequest);
      const fromA = yield* h.next;
      yield* Queue.offer(
        a.replies,
        JSON.stringify({ jsonrpc: "2.0", id: "sample", method: "sampling/createMessage" }),
      );
      const sampling = yield* h.next;
      yield* h.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: sampling.id,
          error: { code: -1, message: "fixture" },
        }),
      );
      assert.deepEqual(JSON.parse(yield* Queue.take(a.sent)), {
        jsonrpc: "2.0",
        id: "sample",
        error: { code: -1, message: "fixture" },
      });
      yield* Queue.offer(
        a.replies,
        JSON.stringify({ jsonrpc: "2.0", id: "cancel-me", method: "roots/list" }),
      );
      const cancelled = yield* h.next;
      yield* Queue.offer(
        a.replies,
        JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: "cancel-me" },
        }),
      );
      assert.deepInclude(yield* h.next, { params: { requestId: cancelled.id } });
      yield* h.push(snapshot("B"));
      const b = yield* h.started;
      yield* h.applied;
      yield* h.applied;
      yield* Queue.offer(b.replies, serverRequest);
      const fromB = yield* h.next;
      assert.notEqual(fromA.id, fromB.id);
      yield* h.send(
        JSON.stringify({ jsonrpc: "2.0", id: fromA.id, result: { roots: ["A-only"] } }),
      );
      yield* h.send(
        JSON.stringify({ jsonrpc: "2.0", id: fromB.id, result: { roots: ["B-only"] } }),
      );
      assert.deepEqual(JSON.parse(yield* Queue.take(b.sent)), {
        jsonrpc: "2.0",
        id: 900,
        result: { roots: ["B-only"] },
      });
      yield* h.send(request(7, "ping"));
      assert.equal((yield* h.next).id, 7);
      assert.equal(yield* Queue.size(b.sent), 0);
    }),
);

it.effect(
  "cancelled request ids are reusable after the instance settles the suppressed reply",
  () =>
    Effect.gen(function* () {
      const h = yield* threadHarness();
      yield* h.push(snapshot("A"));
      const a = yield* h.started;
      yield* h.applied;
      yield* h.send(call(1, "get_guide"));
      yield* Queue.take(a.sent);
      yield* h.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: 1 },
        }),
      );
      yield* Queue.take(a.sent);
      yield* Queue.offer(
        a.replies,
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } }),
      );
      // The following driver notification is a barrier after reply processing, including release.
      yield* Queue.offer(
        a.replies,
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/message" }),
      );
      assert.equal((yield* h.next).method, "notifications/message");
      yield* h.send(call(1, "get_guide"));
      yield* h.send(
        JSON.stringify({ jsonrpc: "2.0", id: "goat-thread-proxy:barrier", method: "ping" }),
      );
      assert.equal((yield* h.next).id, "goat-thread-proxy:barrier");
      assert.equal((JSON.parse(yield* Queue.take(a.sent)) as { id: number }).id, 1);
      yield* Queue.offer(
        a.replies,
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } }),
      );
      assert.equal((yield* h.next).id, 1);
    }),
);

it.effect("handover answers cached setup immediately and refuses calls without a backlog", () =>
  Effect.gen(function* () {
    const killGate = yield* Deferred.make<void>();
    const h = yield* threadHarness({ killGate });
    yield* Effect.addFinalizer(() => Deferred.succeed(killGate, undefined));
    yield* h.push(snapshot("A"));
    const a = yield* h.started;
    yield* h.applied;
    yield* h.send(initialize);
    yield* h.next;
    yield* h.send(initialized);
    yield* h.send(request(101, "tools/list"));
    yield* h.next;
    yield* h.push(snapshot("B"));
    yield* Deferred.await(a.killed);
    yield* h.send(initialize);
    yield* h.send(request(102, "tools/list"));
    for (let id = 1; id <= 256; id++) yield* h.send(request(id, "ping"));
    yield* h.send(work(300));
    yield* h.send(
      JSON.stringify({ jsonrpc: "2.0", id: "goat-thread-proxy:barrier", method: "ping" }),
    );
    assert.deepEqual((yield* h.next).result, serverInfo);
    assert.deepEqual((yield* h.next).result, tools);
    for (let id = 1; id <= 256; id++) assert.equal((yield* h.next).id, id);
    const refusal = yield* h.next;
    assert.equal(refusal.id, 300);
    assert.deepInclude(refusal.result?.structuredContent, { detail: "replaced" });
    assert.equal((yield* h.next).id, "goat-thread-proxy:barrier");
    assert.deepEqual(h.log, ["start 0"]);
    yield* Deferred.succeed(killGate, undefined);
    const b = yield* h.started;
    yield* h.applied;
    yield* h.applied;
    yield* h.send(call(301, "get_guide"));
    assert.equal((JSON.parse(yield* Queue.take(b.sent)) as { id: number }).id, 301);
    assert.equal(yield* Queue.size(b.sent), 0);
  }),
);
