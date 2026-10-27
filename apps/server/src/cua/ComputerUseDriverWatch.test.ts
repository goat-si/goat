import { assert, describe, it } from "@effect/vitest";

import { exitReason } from "./ComputerUseDriverExit.ts";
import { makeDriverWatch } from "./ComputerUseDriverWatch.ts";

const initialize = (id: string | number = 1) =>
  JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: { protocolVersion: "2025-06-18" },
  });
const result = {
  protocolVersion: "2025-06-18",
  capabilities: {},
  serverInfo: { name: "fixture-driver", version: "1.0" },
};
const success = (id: string | number = 1) => JSON.stringify({ jsonrpc: "2.0", id, result });

describe("ComputerUseDriverWatch (#1699)", () => {
  it("a child that exits before initialize succeeds reports its ending once", () => {
    const watch = makeDriverWatch();
    watch.sent(initialize());
    assert.deepEqual(watch.exited(77), {
      driverEnded: { reason: "helper_refused", exitCode: 77 },
    });
    assert.isUndefined(watch.exited(77));
    assert.isUndefined(watch.received(success()));
  });

  it("a correlated initialize success reports once and its later exit says nothing", () => {
    const watch = makeDriverWatch();
    watch.sent(initialize());
    assert.deepEqual(watch.received(success()), { driverEnded: false });
    assert.isUndefined(watch.received(success()));
    assert.isUndefined(watch.exited(134));
  });

  it.each([
    "driver starting",
    '{"jsonrpc":"2.0",',
    "null",
    "[]",
    "1",
    '"log"',
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", result }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, result }),
    JSON.stringify({ jsonrpc: "2.0", id: "1", result }),
    JSON.stringify({ jsonrpc: "2.0", id: null, result }),
    JSON.stringify({ jsonrpc: "1.0", id: 1, result }),
    JSON.stringify({ id: 1, result }),
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32603, message: "initialize failed" },
    }),
    JSON.stringify({ jsonrpc: "2.0", id: 1, result, error: null }),
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ...result, protocolVersion: "2024-11-05" } }),
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ...result, capabilities: [] } }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { ...result, serverInfo: { name: "fixture" } },
    }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { ...result, serverInfo: { name: "", version: "1" } },
    }),
  ])("stdout without a correlated initialize success leaves exit reporting active: %s", (line) => {
    const watch = makeDriverWatch();
    watch.sent(initialize());
    assert.isUndefined(watch.received(line));
    assert.deepEqual(watch.exited(77), { driverEnded: { reason: "helper_refused", exitCode: 77 } });
  });

  it("a failed initialize consumes its ID until a fresh initialize is sent", () => {
    const watch = makeDriverWatch();
    watch.sent(initialize());
    assert.isUndefined(
      watch.received(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32603 } })),
    );
    assert.isUndefined(watch.received(success()));
    watch.sent(initialize());
    assert.deepEqual(watch.received(success()), { driverEnded: false });
  });

  it("replayed and borrowed children accept only their own outgoing wire IDs", () => {
    const replayed = makeDriverWatch();
    const borrowed = makeDriverWatch();
    replayed.sent(initialize("goat-proxy:resume:1"));
    borrowed.sent(initialize("goat-proxy:handshake:1"));
    assert.isUndefined(replayed.received(success(1)));
    assert.isUndefined(borrowed.received(success("goat-proxy:resume:1")));
    assert.deepEqual(replayed.received(success("goat-proxy:resume:1")), { driverEnded: false });
    assert.isUndefined(borrowed.received(success(1)));
    assert.deepEqual(borrowed.received(success("goat-proxy:handshake:1")), { driverEnded: false });
  });

  it.each([
    "noise",
    "[]",
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    JSON.stringify({
      jsonrpc: "2.0",
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "" },
    }),
  ])("a success cannot establish readiness without a valid initialize send: %s", (line) => {
    const watch = makeDriverWatch();
    watch.sent(line);
    assert.isUndefined(watch.received(success()));
  });

  it("stopping suppresses both late initialize success and exit reports", () => {
    const watch = makeDriverWatch();
    watch.sent(initialize());
    watch.stopping();
    assert.isUndefined(watch.received(success()));
    watch.sent(initialize("late"));
    assert.isUndefined(watch.received(success("late")));
    assert.isUndefined(watch.exited(undefined));
  });

  it("reads the helper's refusal codes, and any other exit as a stop or restart", () => {
    assert.equal(exitReason(77), "helper_refused");
    for (const code of [64, 78, 79]) assert.equal(exitReason(code), "helper_unsupported");
    for (const code of [0, 1, 134, undefined]) assert.equal(exitReason(code), "helper_restarted");
  });
});
