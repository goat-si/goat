import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { startOpenCode2Runtime } from "../src/engines/opencode2/runtime.ts";
import { reset, state } from "./fakes/opencode2-runtime.ts";

const fakePath = fileURLToPath(new URL("./fakes/opencode2-runtime.ts", import.meta.url));
const launch = { binary: "fake", args: ["--example"], env: { GOAT2_ENGINE_HELPER_SDK_OPENCODE2: fakePath } };
const start = (signal?: AbortSignal) => startOpenCode2Runtime({ cwd: "/tmp", launch, ...(signal ? { signal } : {}) });

test("accepts exactly one authenticated stream and preserves an immediate event", async () => {
  reset();
  state.earlyEvent = true;
  let ready = false;
  const pending = start().then((runtime) => { ready = true; return runtime; });
  await state.requested.promise;
  assert.equal(ready, false);
  assert.deepEqual(state.requests, ["/api/info", "/api/event"]);
  const authorization = `Basic ${Buffer.from(`opencode:${state.password}`).toString("base64")}`;
  assert.deepEqual(state.authorizations, [authorization, authorization]);
  assert.equal(state.password.length, 43);
  state.release.resolve();
  const runtime = await pending;
  assert.equal(runtime.version, "2.0.28");
  const iterator = runtime.events[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.id, "evt-1");
  await runtime.close();
  await runtime.close();
  assert.equal(await runtime.failure, undefined);
  assert.equal(state.closeCount, 1);
  assert.equal(state.cancelled, true);
  assert.deepEqual(state.requests, ["/api/info", "/api/event"]);
});

test("owns a real fake child and passes launch arguments and v2-only password", async () => {
  const script = fileURLToPath(new URL("./fakes/opencode2-child.ts", import.meta.url));
  const runtime = await startOpenCode2Runtime({ cwd: "/tmp", launch: { binary: process.execPath, args: [script, "fixture-arg"], env: { OPENCODE_PASSWORD: "old-v2", OPENCODE_SERVER_PASSWORD: "old-v1" } } });
  const info = await runtime.client.server.info();
  assert.equal(runtime.version, "2.3.4");
  assert.ok(info.pid > 0);
  await runtime.close();
  assert.throws(() => process.kill(info.pid, 0), { code: "ESRCH" });
});

test("unexpected fake child termination reaches the runtime failure channel", async () => {
  const script = fileURLToPath(new URL("./fakes/opencode2-child.ts", import.meta.url));
  const runtime = await startOpenCode2Runtime({ cwd: "/tmp", launch: { binary: process.execPath, args: [script, "fixture-arg"] } });
  const info = await runtime.client.server.info();
  process.kill(info.pid, "SIGKILL");
  assert.match((await runtime.failure)!.message, /exited unexpectedly/);
  await runtime.close();
});

test("rejects HTTP failure and incorrect SSE content type and closes the owner", async (t) => {
  for (const scenario of ["unauthorized", "bad-type", "wrong-status"] as const) await t.test(scenario, async () => {
    reset();
    if (scenario === "unauthorized") state.eventStatus = 401;
    if (scenario === "bad-type") state.contentType = "application/json";
    if (scenario === "wrong-status") state.eventStatus = 201;
    const pending = start();
    await state.requested.promise;
    state.release.resolve();
    await assert.rejects(pending, /OpenCode 2/);
    assert.equal(state.closeCount, 1);
    assert.equal(state.requests.filter((path) => path === "/api/event").length, 1);
  });
});

test("rejects unauthorized and mismatched server info without exposing credentials", async (t) => {
  for (const scenario of ["unauthorized", "version"] as const) await t.test(scenario, async () => {
    reset();
    if (scenario === "unauthorized") state.infoStatus = 401; else state.version = "1.2.3";
    await assert.rejects(start(), (error: Error) => !error.message.includes(state.password) && /OpenCode 2/.test(error.message));
    assert.equal(state.closeCount, 1);
    assert.deepEqual(state.requests, ["/api/info"]);
  });
});

test("cancellation and process exit while acceptance is held clean up", async (t) => {
  for (const scenario of ["cancel", "exit"] as const) await t.test(scenario, async () => {
    reset();
    const abort = new AbortController();
    const pending = start(abort.signal);
    await state.requested.promise;
    if (scenario === "cancel") abort.abort(); else state.exited!();
    await assert.rejects(pending, /OpenCode 2/);
    assert.equal(state.closeCount, 1);
  });
});

test("startup deadline aborts an unaccepted stream", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  reset();
  const pending = startOpenCode2Runtime({ cwd: "/tmp", launch, startupTimeoutMs: 500 });
  await state.requested.promise;
  t.mock.timers.tick(500);
  await assert.rejects(pending, /OpenCode 2/);
  assert.equal(state.closeCount, 1);
});

test("process loss and stream EOF surface as failures after startup", async (t) => {
  for (const scenario of ["exit", "eof"] as const) await t.test(scenario, async () => {
    reset();
    const pending = start();
    await state.requested.promise;
    state.release.resolve();
    const runtime = await pending;
    if (scenario === "exit") state.exited!(); else state.stream!.close();
    if (scenario === "exit") assert.match((await runtime.failure)!.message, /exited/);
    const iterator = runtime.events[Symbol.asyncIterator]();
    await assert.rejects(iterator.next(), /OpenCode 2/);
    await runtime.close();
    assert.equal(state.closeCount, 1);
  });
});

test("malformed stream data fails visibly through the real SDK parser", async () => {
  reset();
  const pending = start();
  await state.requested.promise;
  state.release.resolve();
  const runtime = await pending;
  state.stream!.enqueue(new TextEncoder().encode("data: {bad json}\n\n"));
  const iterator = runtime.events[Symbol.asyncIterator]();
  await assert.rejects(iterator.next(), /event stream failed/);
  await runtime.close();
});

function holdNextSubscription() {
  state.requested = Promise.withResolvers<void>();
  state.release = Promise.withResolvers<void>();
}

test("reconnect accepts a single new stream after EOF and preserves its early event", async () => {
  reset();
  const pending = start();
  await state.requested.promise;
  state.release.resolve();
  const runtime = await pending;
  const original = runtime.events[Symbol.asyncIterator]();
  await assert.rejects(runtime.reconnect(), /already active/);
  state.stream!.close();
  await assert.rejects(original.next(), /stream ended/);
  holdNextSubscription();
  state.earlyEvent = true;
  let ready = false;
  const reopening = runtime.reconnect().then((stream) => { ready = true; return stream; });
  await state.requested.promise;
  assert.equal(ready, false);
  await assert.rejects(runtime.reconnect(), /already active/);
  assert.equal(state.requests.filter((path) => path === "/api/event").length, 2);
  assert.equal(state.closeCount, 0);
  state.release.resolve();
  const replacement = await reopening;
  assert.equal((await replacement[Symbol.asyncIterator]().next()).value?.id, "evt-1");
  assert.equal(state.authorizations[2], state.authorizations[0]);
  state.exited!();
  assert.match((await runtime.failure)!.message, /exited/);
  await assert.rejects(runtime.reconnect(), /exited/);
  await runtime.close();
});

test("failed reconnection leaves the owner alive and permits a later retry", async () => {
  reset();
  const pending = start();
  await state.requested.promise;
  state.release.resolve();
  const runtime = await pending;
  state.stream!.enqueue(new TextEncoder().encode("data: {bad json}\n\n"));
  await assert.rejects(runtime.events[Symbol.asyncIterator]().next(), /stream failed/);
  holdNextSubscription();
  state.eventStatus = 401;
  const retry = runtime.reconnect();
  await state.requested.promise;
  state.release.resolve();
  await assert.rejects(retry, /subscription/);
  assert.equal(state.closeCount, 0);
  holdNextSubscription();
  state.eventStatus = 200;
  const again = runtime.reconnect();
  await state.requested.promise;
  state.release.resolve();
  await again;
  assert.equal(state.requests.filter((path) => path === "/api/event").length, 3);
  await runtime.close();
});

test("shutdown and process exit win races with a pending reconnection", async (t) => {
  for (const scenario of ["shutdown", "exit"] as const) await t.test(scenario, async () => {
    reset();
    const pending = start();
    await state.requested.promise;
    state.release.resolve();
    const runtime = await pending;
    state.stream!.close();
    await assert.rejects(runtime.events[Symbol.asyncIterator]().next(), /stream ended/);
    holdNextSubscription();
    const reopening = runtime.reconnect();
    await state.requested.promise;
    if (scenario === "shutdown") await runtime.close(); else state.exited!();
    await assert.rejects(reopening, /OpenCode 2/);
    if (scenario === "exit") assert.match((await runtime.failure)!.message, /exited/);
    await assert.rejects(runtime.reconnect(), /closed|exited/);
    await runtime.close();
    assert.equal(state.closeCount, 1);
  });
});

test("a consumer-stopped stream cannot be overlapped by a replacement", async () => {
  reset();
  state.earlyEvent = true;
  const pending = start();
  await state.requested.promise;
  state.release.resolve();
  const runtime = await pending;
  const iterator = runtime.events[Symbol.asyncIterator]();
  await iterator.next();
  await iterator.return!();
  await assert.rejects(runtime.reconnect(), /stopped by its consumer/);
  assert.equal(state.requests.filter((path) => path === "/api/event").length, 1);
  await runtime.close();
});

test("reconnection acceptance deadline leaves the process owned and available", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  reset();
  const pending = start();
  await state.requested.promise;
  state.release.resolve();
  const runtime = await pending;
  state.stream!.close();
  await assert.rejects(runtime.events[Symbol.asyncIterator]().next(), /stream ended/);
  holdNextSubscription();
  const retry = runtime.reconnect({ timeoutMs: 500 });
  await state.requested.promise;
  t.mock.timers.tick(500);
  await assert.rejects(retry, /subscription/);
  assert.equal(state.closeCount, 0);
  await runtime.close();
});

test("a silent OpenCode 2 stream times out and can be reconnected", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); reset();
  const pending = start(); await state.requested.promise; state.release.resolve(); const runtime = await pending;
  try {
    const iterator = runtime.events[Symbol.asyncIterator](); let settled = false;
    const next = iterator.next().then(() => { settled = true; }, () => { settled = true; });
    t.mock.timers.tick(45_000); await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, true); await next;
    holdNextSubscription(); const reopened = runtime.reconnect(); await state.requested.promise; state.release.resolve();
    const stream = await reopened; assert.ok(stream[Symbol.asyncIterator]);
  } finally { await runtime.close(); }
});

test("SSE keepalive bytes renew the OpenCode 2 silence deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); reset();
  const pending = start(); await state.requested.promise; state.release.resolve(); const runtime = await pending;
  try {
    const iterator = runtime.events[Symbol.asyncIterator](); let settled = false;
    const next = iterator.next().then(() => { settled = true; }, () => { settled = true; });
    t.mock.timers.tick(30_000); state.stream!.enqueue(new TextEncoder().encode(": keepalive\n\n"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    t.mock.timers.tick(30_000); await new Promise<void>((resolve) => setImmediate(resolve)); assert.equal(settled, false);
    t.mock.timers.tick(15_000); await new Promise<void>((resolve) => setImmediate(resolve)); assert.equal(settled, true); await next;
  } finally { await runtime.close(); }
});
