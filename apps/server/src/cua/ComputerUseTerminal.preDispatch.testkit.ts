// @effect-diagnostics preferSchemaOverJson:off -- The fixture sends JSON-RPC through the proxy.
import { assert } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type ComputerUsePrimitiveReply,
  type ComputerUsePrimitiveRequest,
} from "@goat/contracts";
import { parse } from "./ComputerUseLeaseProtocol.ts";
import { makeProxyCallScope } from "./ComputerUseLeaseProxyPointBasis.ts";
import {
  finalTerminalLine,
  makePersonStopFence,
  terminalSink,
} from "./ComputerUseLeaseProxyPersonStop.ts";
import { forwardPrimitiveRequests } from "./ComputerUseLeaseProxyOptions.ts";
import { call } from "./ComputerUseLeaseProxy.testkit.ts";
import { snapshot, threadHarness } from "./ComputerUseLeaseProxyThread.testkit.ts";
import { refuseProxyCall } from "./ComputerUseLeaseProxyRefusal.ts";
import { ScreenHostBridge } from "../screenCode/ScreenHostBridge.ts";
import { screenRunLimits } from "../screenCode/ScreenRunLimits.ts";
import {
  replaceWithTerminal,
  terminalReplyState,
  type ComputerUseTerminalReason,
} from "./ComputerUseTerminal.ts";

type Input = { readonly possible: boolean; readonly reasons: readonly ComputerUseTerminalReason[] };

const finalize = (line: string, input: Input) => {
  const final = finalTerminalLine(
    line,
    "not_started",
    { id: 1, method: "tools/call", params: { name: "list_apps" } },
    replaceWithTerminal("none", ...input.reasons),
  );
  return replaceWithTerminal(terminalReplyState(parse(final.line)?.result, "not_started"));
};

const personFence = (reason: ComputerUseTerminalReason) => (input: Input) =>
  Effect.sync(() => {
    const fence = makePersonStopFence();
    if (reason === "stopped_by_person") fence.beginStop();
    else
      fence.beginLock({ result: { isError: true, structuredContent: { code: "screen_locked" } } });
    const line = fence.refusal(1, "tools/call");
    if (line === undefined) throw new Error("expected person-stop refusal");
    return finalize(line, input);
  });

const automation = (kind: "finished" | "paused") => (input: Input) =>
  Effect.gen(function* () {
    let listed = false;
    const line = yield* refuseProxyCall({
      id: 1,
      message:
        parse(
          JSON.stringify({
            id: 1,
            method: "tools/call",
            params: { name: "invoke_menu", arguments: {} },
          }),
        ) ?? {},
      claimPid: 55,
      finished: () => (listed && kind === "finished" ? "expired" : undefined),
      paused: () => (listed && kind === "paused" ? "screen_locked" : undefined),
      idle: () => false,
      apps: () => undefined,
      listed: new Map([[55, { id: "app", name: "App" }]]),
      host: { bundleIds: false },
      shared: () => false,
      toFile: () => undefined,
      tokenFirstRefuses: () => false,
      foreground: () => [],
      listApps: Effect.sync(() => {
        listed = true;
      }),
      automationTargets: true,
    });
    if (line === undefined) return yield* Effect.die("expected automation target refusal");
    assert.include(line, kind === "finished" ? '"detail":"expired"' : '"detail":"screen_locked"');
    return finalize(line, input);
  });

const unsupported = (kind: "batch" | "point") => (input: Input) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const child = {
      driver: { send: () => Effect.void, lines: Stream.empty, kill: Effect.void },
      scope,
      connectionId: "fixture",
      generation: 1,
    };
    const proxy = makeProxyCallScope(
      { listTools: () => Effect.succeed({ tools: [] }), remember: () => {} },
      () => child,
    );
    const name = kind === "batch" ? "run_steps" : "click";
    const args =
      kind === "batch" ? { app_scope: { apps: ["app"] }, steps: [] } : { snapshot_id: "s" };
    const line = JSON.stringify({ id: 1, method: "tools/call", params: { name, arguments: args } });
    const message = parse(line);
    if (message === undefined) return yield* Effect.die("invalid fixture message");
    const answer = yield* proxy.scope(1, line, message, () => "unexpected not-sent answer");
    if (!("refused" in answer)) return yield* Effect.die("expected scope refusal");
    assert.include(answer.refused, kind === "batch" ? "app_scope" : "screenshot");
    const final = finalTerminalLine(
      answer.refused,
      "not_started",
      { id: 1, method: "tools/call", params: { name: "list_apps" } },
      replaceWithTerminal("none", ...input.reasons),
    );
    return replaceWithTerminal(terminalReplyState(parse(final.line)?.result, "not_started"));
  });

const deadline = (input: Input) =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    const answered = yield* Deferred.make<ComputerUsePrimitiveReply>();
    const request: ComputerUsePrimitiveRequest = {
      state: "primitive-request",
      requestId: "request",
      registrationId: "registration",
      controlId: "control",
      connectionGeneration: "connection",
      runId: "run",
      turnId: "turn",
      callId: 1,
      deadlineMillis: 1000,
      tool: "list_apps",
      args: {},
    };
    yield* forwardPrimitiveRequests(
      Stream.make(request),
      (reply) => Deferred.succeed(answered, reply),
      () => "1",
      () => Deferred.await(gate),
      undefined,
      (sink, id) =>
        terminalSink(
          sink,
          { id, method: "tools/call", params: { name: "list_apps" } },
          () => replaceWithTerminal("none", ...input.reasons).reason,
          () => false,
        ),
    );
    yield* TestClock.adjust(1000);
    const reply = yield* Deferred.await(answered);
    return replaceWithTerminal(terminalReplyState(reply.result, reply.status));
  });

const supervisor = (kind: "reserved" | "notReady") => (input: Input) =>
  Effect.gen(function* () {
    const h = yield* threadHarness();
    yield* h.push(snapshot("A"));
    yield* h.started;
    yield* h.applied;
    let stopped = false;
    for (const reason of input.reasons) {
      if (reason === "stopped_by_person") {
        yield* h.push({ state: "control-ended", controlId: "A", reason: "stopped" });
        stopped = true;
      } else {
        yield* h.push({ ...snapshot("A"), state: "paused", reason: "screen_locked" });
        if (!stopped) yield* h.applied;
      }
    }
    yield* h.send(call(kind === "reserved" ? "goat-proxy:reserved" : 1, "list_apps"));
    const answer = yield* h.next;
    return replaceWithTerminal(terminalReplyState(answer.result));
  });

const duplicate = (input: Input) =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    const entered = yield* Deferred.make<void>();
    yield* Effect.addFinalizer(() => Deferred.succeed(gate, undefined));
    const h = yield* threadHarness({
      reservation: (request) =>
        request.action === "reserve"
          ? Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(gate)),
              Effect.as({ status: "refused", detail: "reconnecting" }),
            )
          : Effect.succeed({ status: "released" }),
    });
    yield* h.push(snapshot("A"));
    yield* h.started;
    yield* h.applied;
    const line = call(973, "type_text", { pid: 42, window_id: 7, text: "fixture" });
    yield* h.send(line);
    yield* Deferred.await(entered);
    let stopped = false;
    for (const reason of input.reasons) {
      if (reason === "stopped_by_person") {
        yield* h.push({ state: "control-ended", controlId: "A", reason: "stopped" });
        stopped = true;
      } else {
        yield* h.push({ ...snapshot("A"), state: "paused", reason: "screen_locked" });
        if (!stopped) yield* h.applied;
      }
    }
    yield* h.send(line);
    const answer = yield* h.next;
    return replaceWithTerminal(terminalReplyState(answer.result));
  });

const retiredPrimitive = (input: Input) =>
  Effect.gen(function* () {
    const h = yield* threadHarness();
    yield* h.push(snapshot("A"));
    yield* h.started;
    yield* h.applied;
    let stopped = false;
    for (const reason of input.reasons) {
      if (reason === "stopped_by_person") {
        yield* h.push({ state: "control-ended", controlId: "A", reason: "stopped" });
        stopped = true;
      } else {
        yield* h.push({ ...snapshot("A"), state: "paused", reason: "screen_locked" });
        if (!stopped) yield* h.applied;
      }
    }
    yield* h.push(snapshot("B"));
    yield* h.started;
    yield* h.applied;
    yield* h.sendPrimitive({
      state: "primitive-request",
      requestId: "request",
      registrationId: "registration",
      controlId: "A",
      connectionGeneration: "old",
      runId: "run",
      turnId: "turn",
      callId: 1,
      deadlineMillis: 1000,
      tool: "list_apps",
      args: {},
    });
    const answer = yield* h.primitiveReply;
    return replaceWithTerminal(terminalReplyState(answer.result, answer.status));
  });

const fencedCell = (input: Input) =>
  Effect.gen(function* () {
    const bridge = new ScreenHostBridge();
    for (const reason of input.reasons) bridge.cutCellNow("run", "turn", "cell", reason);
    const answer = yield* bridge.handle(
      {
        t: "call",
        runId: "run",
        turnId: "turn",
        cellId: "cell",
        callId: 1,
        method: "list_apps",
        args: {},
        deadlineMillis: 60000,
      },
      {
        runId: "run",
        turnId: "turn",
        cellId: "cell",
        threadId: "thread",
        environmentId: "env",
        limits: screenRunLimits(),
        invocation: {
          environmentId: EnvironmentId.make("env"),
          capabilities: new Set<"preview">(),
          issuedAt: 0,
          requestNamespace: "test",
          client: undefined,
          thread: {
            threadId: ThreadId.make("thread"),
            providerSessionId: "s",
            providerInstanceId: ProviderInstanceId.make("p"),
          },
        },
      },
    );
    if (answer?.outcome !== "error") return yield* Effect.die("expected fenced cell refusal");
    return replaceWithTerminal(answer.error);
  });

export const preDispatchSites = [
  {
    name: "ComputerUseLeaseProxyPersonStop.lockRefusal",
    undispatched: true,
    run: personFence("screen_locked"),
  },
  {
    name: "ComputerUseLeaseProxyPersonStop.stopRefusal",
    undispatched: true,
    implicitReason: "stopped_by_person" as const,
    run: personFence("stopped_by_person"),
  },
  { name: "ScreenHostBridge.fencedCell", undispatched: true, run: fencedCell },
  {
    name: "ComputerUseLeaseProxyRefusal.automationFinished",
    undispatched: true,
    run: automation("finished"),
  },
  {
    name: "ComputerUseLeaseProxyRefusal.automationPaused",
    undispatched: true,
    run: automation("paused"),
  },
  {
    name: "ComputerUseLeaseProxyThread.retiredPrimitive",
    undispatched: true,
    run: retiredPrimitive,
  },
  { name: "ComputerUseLeaseProxyThread.duplicateId", undispatched: true, run: duplicate },
  {
    name: "ComputerUseLeaseProxyThread.reservedId",
    undispatched: true,
    run: supervisor("reserved"),
  },
  { name: "ComputerUseLeaseProxyThread.notReady", undispatched: true, run: supervisor("notReady") },
  { name: "ComputerUseLeaseProxyOptions.queuedDeadline", undispatched: true, run: deadline },
  { name: "ComputerUseLeaseProxyBatch.scope", undispatched: true, run: unsupported("batch") },
  { name: "ComputerUseLeaseProxyPointBasis.check", undispatched: true, run: unsupported("point") },
];
