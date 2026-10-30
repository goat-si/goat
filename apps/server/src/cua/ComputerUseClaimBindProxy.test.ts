import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { active, call, harness, CONTROL } from "./ComputerUseLeaseProxy.testkit.ts";

it.effect("admits a host bind only for an approved pending window", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* h.push({
      ...active(),
      browserClaimBindings: [
        { claimId: "claim:1", pid: 42, windowId: 7, origin: "https://example.test" },
      ],
    });
    yield* h.applied;
    const current = yield* h.driverStarted;
    yield* h.send(JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list", params: {} }));
    yield* h.nextToDriver;
    yield* h.reply(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 99,
        result: {
          tools: [{ name: "get_browser_state", inputSchema: { properties: { origin_scope: {} } } }],
        },
      }),
    );
    yield* h.nextToProvider;
    yield* h.sendPrimitive({
      state: "primitive-request",
      requestId: "request:bind",
      registrationId: "registration:one",
      controlId: CONTROL,
      connectionGeneration: current.connectionId,
      runId: "run:bind",
      turnId: "turn:bind",
      callId: 0,
      deadlineMillis: 60_000,
      tool: "get_browser_state",
      authority: "claimBind",
      args: { pid: 42, window_id: 7, mode: "bind", origin_scope: ["https://example.test"] },
    });
    const outcome = yield* Effect.raceFirst(
      h.nextToDriver.pipe(Effect.as("sent")),
      h.primitiveReply.pipe(Effect.as("refused")),
    );
    assert.equal(outcome, "sent");
  }),
);

it.effect("agent and screen primitive cannot elevate by placing authority in tool arguments", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* h.push({
      ...active(),
      browserClaimBindings: [
        { claimId: "claim:1", pid: 42, windowId: 7, origin: "https://example.test" },
      ],
    });
    yield* h.applied;
    const current = yield* h.driverStarted;
    yield* h.send(
      call(1, "browser_prepare", {
        pid: 42,
        window_id: 7,
        strategy: "existing_profile",
        authority: "claimBind",
      }),
    );
    assert.equal((yield* h.nextToProvider).id, 1);
    yield* h.sendPrimitive({
      state: "primitive-request",
      requestId: "request:cell",
      registrationId: "registration:one",
      controlId: CONTROL,
      connectionGeneration: current.connectionId,
      runId: "run:cell",
      turnId: "turn:cell",
      callId: 0,
      deadlineMillis: 60_000,
      tool: "get_browser_state",
      args: {
        pid: 42,
        window_id: 7,
        mode: "bind",
        origin_scope: ["https://example.test"],
        authority: "claimBind",
      },
    });
    assert.equal((yield* h.primitiveReply).status, "not_started");
    assert.equal(yield* h.driverQueued, 0);
  }),
);

it.effect.each([
  {
    name: "ungranted or another thread",
    bindings: [],
    tool: "get_browser_state",
    args: { pid: 42, window_id: 7, mode: "bind", origin_scope: ["https://example.test"] },
  },
  {
    name: "another window",
    bindings: [{ claimId: "claim:1", pid: 42, windowId: 7, origin: "https://example.test" }],
    tool: "get_browser_state",
    args: { pid: 42, window_id: 8, mode: "bind", origin_scope: ["https://example.test"] },
  },
  {
    name: "non-bind call",
    bindings: [{ claimId: "claim:1", pid: 42, windowId: 7, origin: "https://example.test" }],
    tool: "browser_click",
    args: { pid: 42, window_id: 7 },
  },
  {
    name: "foreground prepare",
    bindings: [{ claimId: "claim:1", pid: 42, windowId: 7, origin: "https://example.test" }],
    tool: "browser_prepare",
    args: { pid: 42, window_id: 7, strategy: "existing_profile", delivery_mode: "foreground" },
  },
])("refuses host claimBind for $name", ({ bindings, tool, args }) =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* h.push({ ...active(), browserClaimBindings: bindings });
    yield* h.applied;
    const current = yield* h.driverStarted;
    yield* h.sendPrimitive({
      state: "primitive-request",
      requestId: "request:denied",
      registrationId: "registration:one",
      controlId: CONTROL,
      connectionGeneration: current.connectionId,
      runId: "run:bind",
      turnId: "turn:bind",
      callId: 0,
      deadlineMillis: 60_000,
      tool,
      authority: "claimBind",
      args,
    });
    assert.equal((yield* h.primitiveReply).status, "not_started");
    assert.equal(yield* h.driverQueued, 0);
  }),
);
