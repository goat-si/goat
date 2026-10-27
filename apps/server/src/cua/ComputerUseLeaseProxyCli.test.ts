// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off preferSchemaOverJson:off -- Native CLI pipe fixtures use stubbed HTTP JSON reports.
import { assert, describe, it, vi } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeStream from "node:stream";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { parseLeaseProxyArguments } from "./ComputerUseLeaseProxyArguments.ts";
import {
  makePrimitiveReporter,
  postPrimitive,
  runLeaseProxyCli,
} from "./ComputerUseLeaseProxyCli.ts";
import { LEASE_PROXY_ENV } from "./ComputerUseAttachment.ts";
import * as DriverProcess from "./driverProcess.ts";
import * as LeaseProxy from "./ComputerUseLeaseProxy.ts";
import type { LeaseProxyOptions } from "./ComputerUseLeaseProxyOptions.ts";
import type { DriverWatchReport } from "./ComputerUseDriverWatch.ts";

const runDriverFixture = Effect.fn("ComputerUseLeaseProxyCli.testDriver")(function* (input: {
  readonly request?: string;
  readonly handshake?: boolean;
  readonly chunks: ReadonlyArray<string>;
  readonly lines: ReadonlyArray<string>;
  readonly ready: boolean;
  readonly writable?: false;
}) {
  const reports = yield* Queue.unbounded<DriverWatchReport>();
  const collected: Array<DriverWatchReport> = [];
  const stdin = new NodeStream.PassThrough();
  const stdout = new NodeStream.PassThrough();
  const providerInput = new NodeStream.PassThrough();
  const child = Object.assign(new NodeChildProcess.ChildProcess(), {
    stdin,
    stdout,
    stdio: [stdin, stdout, null],
  });
  using _spawn = vi
    .spyOn(DriverProcess, "spawnDriverProcess")
    .mockReturnValue(child as ReturnType<typeof DriverProcess.spawnDriverProcess>);
  using _end = vi.spyOn(DriverProcess, "endDriversWithProxy").mockImplementation(() => undefined);
  using _kill = vi.spyOn(DriverProcess, "killDriverGroup").mockImplementation(() => undefined);
  using _exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  using _stdin = vi
    .spyOn(process, "stdin", "get")
    .mockReturnValue(providerInput as unknown as typeof process.stdin);
  using _fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    if (init?.method !== "POST") return new Response("");
    const body = JSON.parse(String(init.body)) as DriverWatchReport;
    collected.push(body);
    Queue.offerUnsafe(reports, body);
    return new Response(null, { status: 204 });
  });
  using _proxy = vi
    .spyOn(LeaseProxy, "runLeaseProxy")
    .mockImplementation(<EU, ED>(options: LeaseProxyOptions<EU, ED>) =>
      Effect.gen(function* () {
        const driver = yield* input.handshake
          ? (options.startHandshakeDriver ?? options.startDriver)
          : options.startDriver;
        if (input.writable === false) stdin.end();
        if (input.request !== undefined) yield* driver.send(input.request);
        const forwarded = yield* Queue.unbounded<string>();
        const reader = yield* driver.lines.pipe(
          Stream.runForEach((line) => Queue.offer(forwarded, line)),
          Effect.forkScoped,
        );
        for (const chunk of input.chunks) {
          assert.deepEqual(collected, []);
          stdout.write(chunk);
        }
        for (const line of input.lines) assert.equal(yield* Queue.take(forwarded), line);
        // A handshake alone proves nothing; an answered tool call reports the driver working.
        if (input.chunks.at(-1)?.endsWith("\n") !== false) {
          const call = JSON.stringify({ jsonrpc: "2.0", id: "call", method: "tools/call" });
          const answer = JSON.stringify({ jsonrpc: "2.0", id: "call", result: { content: [] } });
          yield* driver.send(call);
          stdout.write(answer + "\n");
          assert.equal(yield* Queue.take(forwarded), answer);
        }
        if (input.ready) yield* Queue.take(reports);
        stdout.end();
        yield* Fiber.join(reader);
        child.emit("exit", 77, null);
        yield* Queue.take(reports);
        const ending = { driverEnded: { reason: "helper_refused", exitCode: 77 } };
        assert.deepEqual(collected, input.ready ? [{ driverEnded: false }, ending] : [ending]);
        return undefined;
      }),
    );
  vi.stubEnv(LEASE_PROXY_ENV.url, "http://goat.test/api/computer-use/lease");
  vi.stubEnv(LEASE_PROXY_ENV.authorization, "Bearer fixture");
  vi.stubEnv(
    LEASE_PROXY_ENV.driver,
    JSON.stringify({ command: "/fixture-driver", args: [], environment: [] }),
  );
  vi.stubEnv(LEASE_PROXY_ENV.proxyChannelToken, undefined);
  try {
    yield* Effect.promise(() =>
      runLeaseProxyCli(["--control", "control:fixture", "--expires", "2030-01-01T00:00:00Z"]),
    );
  } finally {
    vi.unstubAllEnvs();
    stdin.destroy();
    stdout.destroy();
    providerInput.destroy();
  }
});

const initializeRequest = (id: string) =>
  JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: { protocolVersion: "2025-06-18" },
  });
const initializeReply = (id: string) =>
  JSON.stringify({
    jsonrpc: "2.0",
    id,
    result: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      serverInfo: { name: "fixture-driver", version: "1.0" },
    },
  });

describe("driver readiness (#1699)", () => {
  it.effect(
    "stdout noise followed by driver exit reports failure without ever reporting ready",
    () =>
      runDriverFixture({ chunks: ["driver starting\n"], lines: ["driver starting"], ready: false }),
  );
  it.effect("partial initialize stdout followed by driver exit never reports ready", () =>
    runDriverFixture({
      request: initializeRequest("partial"),
      chunks: [initializeReply("partial").slice(0, -1)],
      lines: [],
      ready: false,
    }),
  );
  it.effect(
    "split initialize success reports ready only after the complete frame and preserves stdout",
    () => {
      const reply = initializeReply("goat-proxy:resume:1");
      return runDriverFixture({
        request: initializeRequest("goat-proxy:resume:1"),
        chunks: [reply.slice(0, 30), reply.slice(30) + "\n"],
        lines: [reply],
        ready: true,
      });
    },
  );
  it.effect("an initialize error followed by driver exit never reports ready", () => {
    const reply = JSON.stringify({ jsonrpc: "2.0", id: "failed", error: { code: -32603 } });
    return runDriverFixture({
      request: initializeRequest("failed"),
      chunks: [reply + "\n"],
      lines: [reply],
      ready: false,
    });
  });
  it.effect("a response to initialize that could not be written never reports ready", () => {
    const reply = initializeReply("unwritten");
    return runDriverFixture({
      request: initializeRequest("unwritten"),
      writable: false,
      chunks: [reply + "\n"],
      lines: [reply],
      ready: false,
    });
  });
  it.effect("a borrowed handshake driver reports ready using its rewritten initialize ID", () => {
    const reply = initializeReply("goat-proxy:handshake:1");
    return runDriverFixture({
      handshake: true,
      request: initializeRequest("goat-proxy:handshake:1"),
      chunks: [reply + "\n"],
      lines: [reply],
      ready: true,
    });
  });
});

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
