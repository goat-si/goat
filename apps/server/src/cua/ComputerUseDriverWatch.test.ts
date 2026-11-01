import { assert, describe, it } from "@effect/vitest";

import {
  type ConnectionFailure,
  FAILING_AFTER,
  nextFailure,
  reportedFailure,
} from "./ComputerUseAgentConnections.ts";
import { exitReason } from "./ComputerUseDriverExit.ts";
import { type DriverWatchReport, makeDriverWatch } from "./ComputerUseDriverWatch.ts";

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
const toolCall = (id: number) =>
  JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "list_windows" } });
const toolReply = (id: number) =>
  JSON.stringify({ jsonrpc: "2.0", id, result: { content: [], isError: false } });
/** What the host records from one child's reports, as the lease route passes them on. */
const record = (failure: ConnectionFailure | undefined, report: DriverWatchReport | undefined) =>
  report === undefined
    ? failure
    : nextFailure(failure, report.driverEnded === false ? false : report.driverEnded);
/** Whether the child now reports working: it answers a tool call sent after its handshake. */
const answersCall = (watch: ReturnType<typeof makeDriverWatch>, id = 99) => {
  watch.sent(toolCall(id));
  return watch.received(toolReply(id));
};

describe("ComputerUseDriverWatch (#1699)", () => {
  it("drivers that answer the handshake and crash on their first call trip the host failure", () => {
    let failure: ConnectionFailure | undefined;
    for (let child = 0; child < FAILING_AFTER; child++) {
      const watch = makeDriverWatch();
      watch.sent(initialize());
      failure = record(failure, watch.received(success()));
      watch.sent(toolCall(2));
      failure = record(failure, watch.exited(134));
    }
    assert.equal(reportedFailure(failure)?.reason, "helper_restarted");
  });

  it("a child that exits before initialize succeeds reports its ending once", () => {
    const watch = makeDriverWatch();
    watch.sent(initialize());
    assert.deepEqual(watch.exited(77), {
      driverEnded: { reason: "helper_refused", exitCode: 77 },
    });
    assert.isUndefined(watch.exited(77));
    assert.isUndefined(watch.received(success()));
  });

  it("an answered tool call reports the connection working once, and a later crash still counts", () => {
    const watch = makeDriverWatch();
    watch.sent(initialize());
    assert.isUndefined(watch.received(success()));
    assert.deepEqual(answersCall(watch), { driverEnded: false });
    assert.isUndefined(answersCall(watch, 100));
    assert.deepEqual(watch.exited(134), {
      driverEnded: { reason: "helper_restarted", exitCode: 134 },
    });
    assert.isUndefined(watch.exited(134));
  });

  it("a call sent while a replayed handshake is pending counts once that handshake succeeds", () => {
    const watch = makeDriverWatch();
    watch.sent(initialize("goat-proxy:resume:1"));
    watch.sent(toolCall(3));
    assert.isUndefined(watch.received(success("goat-proxy:resume:1")));
    assert.deepEqual(watch.received(toolReply(3)), { driverEnded: false });
  });

  it("a tool call answered before the child's own handshake proves nothing", () => {
    const watch = makeDriverWatch();
    assert.isUndefined(answersCall(watch));
    watch.sent(initialize());
    assert.isUndefined(watch.received(success()));
    watch.sent(toolCall(5));
    assert.isUndefined(
      watch.received(JSON.stringify({ jsonrpc: "2.0", id: 5, error: { code: -32603 } })),
    );
    assert.deepEqual(answersCall(watch), { driverEnded: false });
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
    assert.isUndefined(answersCall(watch));
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
    assert.isUndefined(watch.received(success()));
    assert.deepEqual(answersCall(watch), { driverEnded: false });
  });

  it("replayed and borrowed children accept only their own outgoing wire IDs", () => {
    const replayed = makeDriverWatch();
    const borrowed = makeDriverWatch();
    replayed.sent(initialize("goat-proxy:resume:1"));
    borrowed.sent(initialize("goat-proxy:handshake:1"));
    assert.isUndefined(replayed.received(success(1)));
    assert.isUndefined(borrowed.received(success("goat-proxy:resume:1")));
    assert.isUndefined(replayed.received(success("goat-proxy:resume:1")));
    assert.deepEqual(answersCall(replayed), { driverEnded: false });
    assert.isUndefined(borrowed.received(success(1)));
    assert.isUndefined(answersCall(borrowed));
    assert.isUndefined(borrowed.received(success("goat-proxy:handshake:1")));
    assert.deepEqual(answersCall(borrowed), { driverEnded: false });
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
    assert.isUndefined(answersCall(watch));
  });

  it("stopping suppresses both a late answered call and exit reports", () => {
    const watch = makeDriverWatch();
    watch.sent(initialize());
    assert.isUndefined(watch.received(success()));
    watch.sent(toolCall(7));
    watch.stopping();
    assert.isUndefined(watch.received(toolReply(7)));
    assert.isUndefined(answersCall(watch));
    assert.isUndefined(watch.exited(undefined));
  });

  it("reads the helper's refusal codes, and any other exit as a stop or restart", () => {
    assert.equal(exitReason(77), "helper_refused");
    for (const code of [64, 78, 79]) assert.equal(exitReason(code), "helper_unsupported");
    for (const code of [0, 1, 134, undefined]) assert.equal(exitReason(code), "helper_restarted");
  });
});
