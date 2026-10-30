import { assert, describe, it } from "@effect/vitest";
import { ThreadId, type ComputerUsePrimitiveRequest } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ComputerUseLeases from "./ComputerUseLeases.ts";
import * as PrimitiveChannel from "./ComputerUsePrimitiveChannel.ts";

const threadId = ThreadId.make("thread:caps");
const controlId = "control:caps";
const authority = {
  threadId,
  attachmentGeneration: "attachment:one",
  proxyChannelToken: "channel:secret",
};

/** A bound channel on the TestClock at 0, whose cell ends at cellDeadline. */
const bound = Effect.fn("PrimitiveChannelCapsTest.bound")(function* (ready = true) {
  const signals = yield* PubSub.unbounded<void>();
  const leases = ComputerUseLeases.ComputerUseLeases.of({
    currentControl: () => Effect.succeedSome({ controlId }),
    controlState: () => Effect.succeed({ _tag: "active" }),
    subscribe: PubSub.subscribe(signals),
  } as unknown as ComputerUseLeases.ComputerUseLeases["Service"]);
  const channel = yield* PrimitiveChannel.make.pipe(
    Effect.provideService(ComputerUseLeases.ComputerUseLeases, leases),
  );
  yield* channel.issue({ ...authority, expiresAt: 600_000 });
  const registered = yield* channel.registerStream({
    ...authority,
    proxyInstanceId: "proxy:one",
    kind: "thread",
  });
  if (registered.status !== "registered") throw new Error("expected registration");
  if (ready)
    assert.isTrue(
      yield* channel.reportControlReady({
        ...authority,
        registrationId: registered.registrationId,
        controlId,
        connectionId: "driver:1",
        driverGeneration: 1,
      }),
    );
  const call = (tool: string, args: ComputerUsePrimitiveRequest["args"], cellDeadline = 30_000) =>
    channel
      .request({
        threadId,
        runId: "run:one",
        turnId: "cell:one",
        callId: 1,
        deadlineMillis: cellDeadline,
        tool,
        args,
      })
      .pipe(Effect.result, Effect.forkChild);
  /** The proxy takes the next request, which marks it sent. */
  const delivered = Stream.runHead(
    registered.requests.pipe(
      Stream.filter(
        (item): item is ComputerUsePrimitiveRequest => item.state === "primitive-request",
      ),
    ),
  ).pipe(Effect.map(Option.getOrThrow));
  /** The next line the proxy reads, cancellations included. */
  const next = Stream.runHead(registered.requests).pipe(Effect.map(Option.getOrThrow));
  return { call, delivered, next, channel };
});

describe("ComputerUsePrimitiveChannel caps each driver call", () => {
  it.effect(
    "a list_apps the driver never answers fails at its own cap, and only its cell's end cancels it",
    () =>
      Effect.gen(function* () {
        const f = yield* bound();
        const waiter = yield* f.call("list_apps", {});
        const request = yield* f.delivered;
        assert.equal(request.deadlineMillis, 2_000);
        yield* TestClock.adjust(2_000 + PrimitiveChannel.PROXY_ANSWER_GRACE_MS);
        const result = yield* Fiber.join(waiter);
        assert.equal(result._tag, "Failure");
        if (result._tag !== "Failure") return;
        assert.equal(result.failure.code, "deadline");
        assert.isTrue(result.failure.effectStarted);
        assert.equal(
          result.failure.nextStep,
          "The driver did not answer within 2 s and may still be working on it. Observe before acting again; do not resend input.",
        );
        const marker = yield* f.next.pipe(Effect.forkChild);
        yield* f.channel.cancel("run:one", "cell:one");
        assert.deepEqual(yield* Fiber.join(marker), {
          state: "primitive-cancel",
          requestId: request.requestId,
        });
      }),
  );

  it.effect(
    "a call the proxy says it never sent, within the grace past its cap, fails as nothing sent",
    () =>
      Effect.gen(function* () {
        const f = yield* bound();
        const waiter = yield* f.call("list_apps", {});
        const request = yield* f.delivered;
        yield* TestClock.adjust(2_000);
        assert.isTrue(
          yield* f.channel.reply({
            ...authority,
            registrationId: request.registrationId,
            reply: { ...request, status: "not_started" },
          }),
        );
        const result = yield* Fiber.join(waiter);
        assert.equal(result._tag, "Success");
        if (result._tag === "Success") assert.equal(result.success.status, "not_started");
      }),
  );

  it.effect("a driver answer that lands in the grace past the cap still fails at the cap", () =>
    Effect.gen(function* () {
      const f = yield* bound();
      const waiter = yield* f.call("list_apps", {});
      const request = yield* f.delivered;
      yield* TestClock.adjust(2_500);
      assert.isTrue(
        yield* f.channel.reply({
          ...authority,
          registrationId: request.registrationId,
          reply: { ...request, status: "settled", result: { content: [] } },
        }),
      );
      const result = yield* Fiber.join(waiter);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure.code, "deadline");
        assert.isTrue(result.failure.effectStarted);
      }
    }),
  );

  it.effect("a late answer naming another call does not clear a call its cell gave up on", () =>
    Effect.gen(function* () {
      const f = yield* bound();
      const waiter = yield* f.call("list_apps", {});
      const request = yield* f.delivered;
      yield* TestClock.adjust(2_000 + PrimitiveChannel.PROXY_ANSWER_GRACE_MS);
      assert.equal((yield* Fiber.join(waiter))._tag, "Failure");
      assert.isFalse(
        yield* f.channel.reply({
          ...authority,
          registrationId: request.registrationId,
          reply: { ...request, callId: request.callId + 1, status: "settled" },
        }),
      );
      const marker = yield* f.next.pipe(Effect.forkChild);
      yield* f.channel.cancel("run:one", "cell:one");
      assert.deepEqual(yield* Fiber.join(marker), {
        state: "primitive-cancel",
        requestId: request.requestId,
      });
    }),
  );

  it.effect("a call the driver never took fails at its cap as nothing sent", () =>
    Effect.gen(function* () {
      const f = yield* bound();
      const waiter = yield* f.call("click", { pid: 4, window_id: 9, x: 1, y: 1 });
      yield* TestClock.adjust(3_000 + PrimitiveChannel.PROXY_ANSWER_GRACE_MS);
      const result = yield* Fiber.join(waiter);
      assert.equal(result._tag, "Failure");
      if (result._tag !== "Failure") return;
      assert.equal(result.failure.code, "deadline");
      assert.isFalse(result.failure.effectStarted);
      assert.include(result.failure.nextStep, "nothing was sent");
    }),
  );

  it.effect("a wait's cap follows its own timeout and a long type's its length", () =>
    Effect.gen(function* () {
      const f = yield* bound();
      yield* f.call("verify_state", { timeout_ms: 5_000 });
      assert.equal((yield* f.delivered).deadlineMillis, 7_000);
      yield* f.call("type_text", { text: "x".repeat(100) });
      assert.equal((yield* f.delivered).deadlineMillis, 8_000);
      yield* f.call("get_window_state", { include_screenshot: true });
      assert.equal((yield* f.delivered).deadlineMillis, 7_000);
    }),
  );

  it.effect("a cell with less time than the cap fails the call before the cell ends", () =>
    Effect.gen(function* () {
      const f = yield* bound();
      yield* f.call("scroll", {}, 4_000);
      assert.equal((yield* f.delivered).deadlineMillis, 2_500);
    }),
  );

  it.effect("a call with under 250 ms to answer in is refused before it is queued", () =>
    Effect.gen(function* () {
      const f = yield* bound();
      const result = yield* Fiber.join(yield* f.call("click", {}, 1_700));
      assert.equal(result._tag, "Failure");
      if (result._tag !== "Failure") return;
      assert.equal(result.failure.code, "deadline");
      assert.isFalse(result.failure.effectStarted);
      assert.include(result.failure.nextStep, "new cell");
    }),
  );

  it.effect(
    "waiting for a driver to bind counts against the call's cap and the cell's reserve",
    () =>
      Effect.gen(function* () {
        const f = yield* bound(false);
        const capped = yield* f.call("list_apps", {});
        const short = yield* f.call("click", {}, 1_800);
        // The short cell keeps its 1.5 s reserve: the call gives up waiting at 300 ms.
        yield* TestClock.adjust(300);
        const early = yield* Fiber.join(short);
        assert.equal(early._tag, "Failure");
        yield* TestClock.adjust(1_700);
        const result = yield* Fiber.join(capped);
        assert.equal(result._tag, "Failure");
        if (result._tag !== "Failure") return;
        assert.equal(result.failure.reason, "desktop_not_ready");
        assert.isFalse(result.failure.effectStarted);
      }),
  );
});
