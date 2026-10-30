import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { EnvironmentId, ThreadId } from "@goat/contracts";
import * as Bind from "../preview/BrowserClaimBind.ts";
import { makeBrowserOriginGrants } from "../preview/BrowserOriginGrants.ts";
import { active, call, harness, CONTROL } from "./ComputerUseLeaseProxy.testkit.ts";

it.effect("admits a host bind only for an approved pending window under app restrictions", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* h.push({
      ...active(undefined, ["other.app"]),
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
      h.nextToDriver.pipe(Effect.map((message) => JSON.stringify(message))),
      h.primitiveReply.pipe(Effect.as("refused")),
    );
    assert.include(outcome, "get_browser_state");
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

it.effect.each([true, false])(
  "rejects forged authority for agent and screen ingress when claimed=%s",
  (claimed) =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.push({
        ...active(),
        ...(claimed
          ? {
              browserClaims: [
                {
                  claimId: "live",
                  claimGeneration: 1,
                  pid: 42,
                  windowId: 7,
                  tabId: "tab",
                  origins: ["https://example.test"],
                },
              ],
            }
          : {}),
      });
      yield* h.applied;
      const current = yield* h.driverStarted;
      for (const { id, name } of [
        { id: 1, name: "get_browser_state" },
        { id: 2, name: "browser_prepare" },
      ]) {
        yield* h.send(
          call(id, name, {
            authority: "claimBind",
            pid: 42,
            window_id: 7,
            tab_id: "tab",
            mode: "bind",
            strategy: { kind: "existing_profile" },
            origin_scope: ["https://example.test"],
          }),
        );
        assert.equal((yield* h.nextToProvider).id, id);
      }
      yield* h.sendPrimitive({
        state: "primitive-request",
        requestId: "screen:forged",
        registrationId: "registration:one",
        controlId: CONTROL,
        connectionGeneration: current.connectionId,
        runId: "screen",
        turnId: "cell",
        callId: 3,
        deadlineMillis: 60_000,
        tool: "browser_prepare",
        args: {
          authority: "claimBind",
          pid: 42,
          window_id: 7,
          strategy: { kind: "existing_profile" },
        },
      });
      assert.equal((yield* h.primitiveReply).status, "not_started");
      assert.equal(yield* h.driverQueued, 0);
    }),
);

it.effect("binds the approved active tab through the primitive and proxy before attaching", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* h.push(active());
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
    const ref = yield* Deferred.make<Effect.Success<ReturnType<typeof makeBrowserOriginGrants>>>();
    let calls = 0;
    const bind = yield* Bind.makeBrowserClaimBind({
      request: (input) =>
        Effect.gen(function* () {
          calls++;
          const grants = yield* Deferred.await(ref);
          yield* h.push({
            ...active(),
            browserClaimBindings: yield* grants.bindingsFor(input.threadId),
          });
          yield* h.applied;
          yield* h.sendPrimitive({
            state: "primitive-request",
            requestId: "request:bind",
            registrationId: "registration:one",
            controlId: CONTROL,
            connectionGeneration: current.connectionId,
            runId: input.runId,
            turnId: input.turnId,
            callId: input.callId,
            deadlineMillis: input.deadlineMillis,
            tool: input.tool,
            ...(input.authority === undefined ? {} : { authority: input.authority }),
            ...(input.bindingVersion === undefined ? {} : { bindingVersion: input.bindingVersion }),
            args: input.args,
          });
          const reply = yield* h.primitiveReply;
          return { ...reply, driverGeneration: 1 };
        }),
    });
    const hash = "a".repeat(64);
    const grants = yield* makeBrowserOriginGrants({
      environmentId: EnvironmentId.make("environment:test"),
      supported: () => true,
      publish: () => Effect.succeed(hash),
      confirm: () =>
        Effect.succeed({
          capability_manifest: { sha256: hash, file_sha256: hash, reload_error: null },
        }),
      bind,
    });
    yield* Deferred.succeed(ref, grants);
    const request = yield* grants.request({
      threadId: ThreadId.make("thread:one"),
      pid: 42,
      windowId: 7,
      origin: "https://example.test",
      windowTitle: "Browser",
    });
    if (request.status !== "pending") return assert.fail("expected pending");
    assert.equal(calls, 0);
    const answer = yield* grants
      .answer(request.claimId, true)
      .pipe(Effect.forkChild({ startImmediately: true }));
    const sent = yield* h.nextToDriver;
    const params = sent.params;
    if (typeof params !== "object" || params === null || !("arguments" in params))
      return assert.fail("missing arguments");
    assert.deepEqual(params.arguments, {
      pid: 42,
      window_id: 7,
      origin_scope: ["https://example.test"],
      session: `goat-claim:${request.claimId}`,
    });
    yield* h.reply(
      JSON.stringify({
        jsonrpc: "2.0",
        id: sent.id,
        result: {
          structuredContent: {
            mode: "bind",
            tabs: [
              { tab_id: "tab", active: true, title: "Site", url: "https://example.test/page" },
            ],
          },
        },
      }),
    );
    const attached = yield* Fiber.join(answer);
    assert.equal(attached.agentResult.status, "attached");
    if (attached.agentResult.status === "attached") {
      assert.equal(attached.agentResult.claim.tab.tabId, "tab");
      assert.equal(attached.agentResult.claim.title, "Site");
    }
  }),
);

it.effect("withholds an approved bind if the pending claim ends before final send", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    const h = yield* harness({ onTarget: () => true, targetGate: gate });
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
      requestId: "request:held",
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
    yield* h.reported;
    yield* h.push({ ...active(), browserClaimBindings: [] });
    yield* h.applied;
    yield* Deferred.succeed(gate, undefined);
    assert.equal((yield* h.primitiveReply).status, "not_started");
    assert.equal(yield* h.driverQueued, 0);
  }),
);

it.effect("admits existing-profile prepare only for the approved pending window", () =>
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
      requestId: "request:prepare",
      registrationId: "registration:one",
      controlId: CONTROL,
      connectionGeneration: current.connectionId,
      runId: "run:bind",
      turnId: "turn:bind",
      callId: 0,
      deadlineMillis: 60_000,
      tool: "browser_prepare",
      authority: "claimBind",
      args: {
        pid: 42,
        window_id: 7,
        strategy: { kind: "existing_profile" },
        session: "goat-claim:claim:1",
      },
    });
    const outcome = yield* Effect.raceFirst(
      h.nextToDriver.pipe(Effect.as("sent")),
      h.primitiveReply.pipe(Effect.as("refused")),
    );
    assert.equal(outcome, "sent");
  }),
);
