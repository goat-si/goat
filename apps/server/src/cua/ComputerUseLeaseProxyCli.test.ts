// @effect-diagnostics globalFetchInEffect:off preferSchemaOverJson:off -- Stubbed HTTP reports are decoded as wire JSON.
import { assert, describe, it, vi } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import { parseLeaseProxyArguments } from "./ComputerUseLeaseProxyArguments.ts";
import { makePrimitiveReporter, postPrimitive } from "./ComputerUseLeaseProxyCli.ts";

describe("primitive report sequencer", () => {
  it.effect("a failed primitive reply POST returns zero and a later POST still succeeds", () =>
    Effect.gen(function* () {
      let calls = 0;
      using _fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        if (++calls === 1) throw new Error("connection reset");
        return new Response(null, { status: 204 });
      });
      const url = "http://goat.test/api/computer-use/primitive-reply";
      assert.equal(yield* postPrimitive(url, "Bearer fixture", "channel:fixture", {}), 0);
      assert.equal(yield* postPrimitive(url, "Bearer fixture", "channel:fixture", {}), 204);
    }),
  );
  it.effect("a rejected ready POST retries and keeps the reporter alive", () =>
    Effect.gen(function* () {
      const attempts = yield* Queue.unbounded<number>();
      let count = 0;
      using _fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        const attempt = ++count;
        Queue.offerUnsafe(attempts, attempt);
        if (attempt === 1) throw new Error("connection reset");
        return new Response(null, { status: 204 });
      });
      const registration = yield* Deferred.make<string>();
      const reporter = yield* makePrimitiveReporter({
        url: "http://goat.test/api/computer-use/lease",
        authorization: "Bearer fixture",
        token: "channel:fixture",
        registration,
      });
      yield* reporter.enqueue({
        kind: "ready",
        controlId: "A",
        connectionId: "driver:0",
        driverGeneration: 0,
      });
      yield* reporter.run.pipe(Effect.forkScoped);
      yield* Deferred.succeed(registration, "registration:fixture");
      assert.equal(yield* Queue.take(attempts), 1);
      yield* TestClock.adjust("250 millis");
      assert.equal(yield* Queue.take(attempts), 2);
      assert.isFalse(reporter.failed);
    }).pipe(Effect.scoped),
  );
  it.effect("missing registration header leaves the primitive reporter closed", () =>
    Effect.gen(function* () {
      const registration = yield* Deferred.make<string>();
      const reporter = yield* makePrimitiveReporter({
        url: "http://goat.test/api/computer-use/lease",
        authorization: "Bearer fixture",
        token: "channel:fixture",
        registration,
      });
      yield* reporter.enqueue({
        kind: "ready",
        controlId: "A",
        connectionId: "driver:zero",
        driverGeneration: 0,
      });
      const running = yield* reporter.run.pipe(Effect.forkScoped);
      yield* Deferred.succeed(registration, "");
      yield* Fiber.join(running);
      assert.isTrue(reporter.failed);
    }).pipe(Effect.scoped),
  );

  it.effect("401 stops subsequent primitive reports", () =>
    Effect.gen(function* () {
      const posts = yield* Queue.unbounded<string>();
      using _fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
        Queue.offerUnsafe(posts, String(url));
        return new Response(null, { status: 401 });
      });
      const registration = yield* Deferred.make<string>();
      const reporter = yield* makePrimitiveReporter({
        url: "http://goat.test/api/computer-use/lease",
        authorization: "Bearer fixture",
        token: "channel:fixture",
        registration,
      });
      yield* reporter.enqueue({
        kind: "ready",
        controlId: "A",
        connectionId: "driver:0",
        driverGeneration: 0,
      });
      const running = yield* reporter.run.pipe(Effect.forkScoped);
      yield* Deferred.succeed(registration, "registration:fixture");
      assert.include(yield* Queue.take(posts), "primitive-control-ready");
      yield* Fiber.join(running);
      assert.isTrue(reporter.failed);
      yield* reporter.enqueue({
        kind: "ready",
        controlId: "A",
        connectionId: "driver:1",
        driverGeneration: 1,
      });
      assert.equal(yield* Queue.size(posts), 0);
    }).pipe(Effect.scoped),
  );

  it.effect("a stalled cutoff POST coalesces later cutoffs before the newest ready", () =>
    Effect.gen(function* () {
      const posts = yield* Queue.unbounded<{
        readonly url: string;
        readonly body: {
          readonly connectionId: string;
          readonly driverGeneration: number;
        };
      }>();
      let releaseFirst: () => void = () => undefined;
      const firstHeld = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let count = 0;
      using _fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        Queue.offerUnsafe(posts, { url: String(url), body: JSON.parse(String(init?.body)) });
        if (count++ === 0) await firstHeld;
        return new Response(null, { status: 204 });
      });
      const registration = yield* Deferred.make<string>();
      const reporter = yield* makePrimitiveReporter({
        url: "http://goat.test/api/computer-use/lease",
        authorization: "Bearer fixture",
        token: "channel:fixture",
        registration,
      });
      yield* reporter.enqueue({
        kind: "cutoff",
        controlId: "A",
        connectionId: "driver:0",
        driverGeneration: 0,
      });
      yield* reporter.run.pipe(Effect.forkScoped);
      yield* Deferred.succeed(registration, "registration:fixture");
      const first = yield* Queue.take(posts);
      assert.include(first.url, "primitive-control-cutoff");
      assert.equal(first.body.connectionId, "driver:0");
      yield* reporter.enqueue({
        kind: "ready",
        controlId: "A",
        connectionId: "driver:1",
        driverGeneration: 1,
      });
      yield* reporter.enqueue({
        kind: "cutoff",
        controlId: "A",
        connectionId: "driver:1",
        driverGeneration: 1,
      });
      yield* reporter.enqueue({
        kind: "ready",
        controlId: "A",
        connectionId: "driver:2",
        driverGeneration: 2,
      });
      releaseFirst();
      const second = yield* Queue.take(posts);
      assert.include(second.url, "primitive-control-cutoff");
      assert.equal(second.body.connectionId, "driver:1");
      assert.equal(second.body.driverGeneration, 1);
      const third = yield* Queue.take(posts);
      assert.include(third.url, "primitive-control-ready");
      assert.equal(third.body.connectionId, "driver:2");
      assert.equal(third.body.driverGeneration, 2);
    }).pipe(Effect.scoped),
  );

  it.effect("cutoff supersedes an unsent ready and carries its own connection identity", () =>
    Effect.gen(function* () {
      const posts = yield* Queue.unbounded<{
        readonly url: string;
        readonly body: {
          readonly registrationId: string;
          readonly controlId: string;
          readonly connectionId: string;
          readonly driverGeneration: number;
        };
      }>();
      using _fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        Queue.offerUnsafe(posts, { url: String(url), body: JSON.parse(String(init?.body)) });
        return new Response(null, { status: 204 });
      });
      const registration = yield* Deferred.make<string>();
      const reporter = yield* makePrimitiveReporter({
        url: "http://goat.test/api/computer-use/lease",
        authorization: "Bearer fixture",
        token: "channel:fixture",
        registration,
      });
      yield* reporter.enqueue({
        kind: "ready",
        controlId: "A",
        connectionId: "driver:0",
        driverGeneration: 0,
      });
      yield* reporter.enqueue({
        kind: "cutoff",
        controlId: "A",
        connectionId: "driver:0",
        driverGeneration: 0,
      });
      yield* reporter.run.pipe(Effect.forkScoped);
      yield* Deferred.succeed(registration, "registration:fixture");
      const first = yield* Queue.take(posts);
      assert.include(first.url, "primitive-control-cutoff");
      assert.deepEqual(first.body, {
        registrationId: "registration:fixture",
        controlId: "A",
        connectionId: "driver:0",
        driverGeneration: 0,
      });
      yield* reporter.enqueue({
        kind: "ready",
        controlId: "A",
        connectionId: "driver:1",
        driverGeneration: 1,
      });
      const second = yield* Queue.take(posts);
      assert.include(second.url, "primitive-control-ready");
      assert.equal(second.body.connectionId, "driver:1");
    }).pipe(Effect.scoped),
  );

  it.effect("more than eight unacknowledged controls close the primitive report path", () =>
    Effect.gen(function* () {
      const registration = yield* Deferred.make<string>();
      const reporter = yield* makePrimitiveReporter({
        url: "http://goat.test/api/computer-use/lease",
        authorization: "Bearer fixture",
        token: "channel:fixture",
        registration,
      });
      for (let index = 0; index < 9; index++)
        yield* reporter.enqueue({
          kind: "cutoff",
          controlId: `control:${index}`,
          connectionId: `driver:${index}`,
          driverGeneration: index,
        });
      assert.isTrue(reporter.failed);
    }),
  );
});

describe("lease proxy arguments", () => {
  it("accepts thread or legacy control mode", () => {
    assert.deepEqual(parseLeaseProxyArguments(["--thread", "thread:one"]), {
      mode: "thread",
      threadId: "thread:one",
    });
    assert.equal(
      parseLeaseProxyArguments(["--control", "control:one", "--expires", "2030-01-01T00:00:00Z"])
        ?.mode,
      "control",
    );
  });
  it("accepts and ignores a thread driver's launch fingerprint in either option order", () => {
    const fingerprint = "a".repeat(64);
    for (const args of [
      ["--thread", "thread:one", "--driver-fingerprint", fingerprint],
      ["--driver-fingerprint", fingerprint, "--thread", "thread:one"],
    ])
      assert.deepEqual(parseLeaseProxyArguments(args), { mode: "thread", threadId: "thread:one" });
  });
  it.each([
    [],
    ["--thread"],
    ["--thread", ""],
    ["--thread", "t", "--control", "c"],
    ["--thread", "t", "--expires", "2030-01-01T00:00:00Z"],
    ["--control", "c"],
    ["--control", "c", "--expires", "invalid"],
    ["--thread", "t", "--unknown", "x"],
    ["--thread", "a", "--thread", "b"],
    ["--control", "c", "--expires", "2030-01-01T00:00:00Z", "--unknown", "x"],
    ["--thread", "--control"],
    ["--thread", "t", "unexpected"],
    ["--driver-fingerprint", "a"],
    ["--thread", "t", "--driver-fingerprint"],
    ["--thread", "t", "--driver-fingerprint", ""],
    ["--thread", "t", "--driver-fingerprint", "a", "--driver-fingerprint", "b"],
    ["--thread", "t", "--driver-fingerprint", "a", "--unknown", "x"],
    ["--thread", "t", "--driver-fingerprint", "a", "--control", "c"],
    ["--thread", "t", "--driver-fingerprint", "a", "--expires", "2030-01-01T00:00:00Z"],
    ["--control", "c", "--expires", "2030-01-01T00:00:00Z", "--driver-fingerprint", "a"],
  ])("rejects mixed, missing, duplicate or unknown arguments: %j", (...args) => {
    assert.isUndefined(parseLeaseProxyArguments(args));
  });
});
