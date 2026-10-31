// @effect-diagnostics preferSchemaOverJson:off -- The fixture sends JSON-RPC through the proxy.
import { assert } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
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
import { active, call, CONTROL, harness } from "./ComputerUseLeaseProxy.testkit.ts";
import { snapshot, threadHarness } from "./ComputerUseLeaseProxyThread.testkit.ts";
import { refuseProxyCall } from "./ComputerUseLeaseProxyRefusal.ts";
import { ScreenHostBridge } from "../screenCode/ScreenHostBridge.ts";
import { screenRunLimits } from "../screenCode/ScreenRunLimits.ts";
import * as ComputerUseLeases from "./ComputerUseLeases.ts";
import * as PrimitiveChannel from "./ComputerUsePrimitiveChannel.ts";
import {
  replaceWithTerminal,
  terminalReplyState,
  type ComputerUseTerminalReason,
  type ComputerUseTerminalState,
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

const supervisor = (kind: "reserved" | "notReady" | "transportLost") => (input: Input) =>
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
    if (kind === "transportLost") {
      yield* h.push({ state: "reconnecting" });
      yield* h.push({ state: "transport_lost" });
    }
    yield* h.send(call(kind === "reserved" ? "goat-proxy:reserved" : 1, "list_apps"));
    const answer = yield* h.next;
    return replaceWithTerminal(terminalReplyState(answer.result));
  });

const reconnecting = (input: Input) =>
  Effect.gen(function* () {
    const h = yield* threadHarness();
    yield* h.push({ state: "reconnecting" });
    yield* h.send(call(1, "list_apps"));
    const answer = JSON.stringify(yield* h.next);
    assert.include(answer, '"detail":"reconnecting"');
    return finalize(answer, input);
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

const channelRefusal =
  (kind: "retainedWaiter" | "authority" | "activeRace" | "activeRaceClosed") => (input: Input) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("matrix:channel");
      const signals = yield* PubSub.unbounded<void>();
      const expiresAt = DateTime.makeUnsafe(60000);
      const reason = input.reasons.includes("stopped_by_person")
        ? "stopped_by_person"
        : "screen_locked";
      const entered = yield* Deferred.make<void>();
      const admissionGate = yield* Deferred.make<void>();
      yield* Effect.addFinalizer(() => Deferred.succeed(admissionGate, undefined));
      let armed = false;
      let reads = 0;
      let notify: Parameters<
        NonNullable<ComputerUseLeases.ComputerUseLeases["Service"]["onAuthorityChange"]>
      >[0] = () => {};
      const leases = yield* ComputerUseLeases.ComputerUseLeases.pipe(
        Effect.provide(
          Layer.mock(ComputerUseLeases.ComputerUseLeases)({
            proxy: undefined,
            currentControl: () => Effect.succeedSome({ threadId, controlId: "A", expiresAt }),
            controlState: () => {
              const activeRace = kind === "activeRace" || kind === "activeRaceClosed";
              if (activeRace && armed) reads++;
              const state: ComputerUseLeases.ComputerUseControlState =
                kind === "authority" || (activeRace && armed && reads >= 2)
                  ? reason === "stopped_by_person"
                    ? { _tag: "ended", reason: "stopped" }
                    : { _tag: "paused", reason: "screen_locked" }
                  : {
                      _tag: "active",
                      expiresAt,
                      interruptions: { count: 0, last: "screen_locked" },
                      apps: undefined,
                      wakeAt: 60000,
                    };
              if (activeRace && armed && reads === 2)
                return Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(admissionGate)),
                  Effect.as(state),
                );
              return Effect.succeed(state);
            },
            subscribe: PubSub.subscribe(signals),
            onAuthorityChange: (listener) => {
              notify = listener;
              return () => {};
            },
          }),
        ),
      );
      const channel = yield* PrimitiveChannel.make.pipe(
        Effect.provideService(ComputerUseLeases.ComputerUseLeases, leases),
      );
      const authority = { threadId, attachmentGeneration: "a", proxyChannelToken: "fixture" };
      yield* channel.issue({ ...authority, expiresAt: 60000 });
      const registered = yield* channel.registerStream({
        ...authority,
        proxyInstanceId: "p",
        kind: "thread",
      });
      if (registered.status !== "registered") return yield* Effect.die("registration failed");
      const reading = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const clock = yield* Clock.Clock;
      let hold = false;
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
      armed = true;
      const pending = yield* channel
        .request({
          threadId,
          runId: "run",
          turnId: "turn",
          callId: 1,
          deadlineMillis: 30000,
          tool: "list_apps",
          args: {},
        })
        .pipe(
          Effect.provideService(Clock.Clock, {
            ...clock,
            currentTimeMillis: Effect.suspend(() =>
              hold
                ? Deferred.succeed(reading, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                    Effect.andThen(clock.currentTimeMillis),
                  )
                : clock.currentTimeMillis,
            ),
          }),
          Effect.result,
          Effect.forkChild({ startImmediately: true }),
        );
      if (kind === "activeRace" || kind === "activeRaceClosed") {
        yield* Deferred.await(entered);
        if (kind === "activeRaceClosed")
          yield* channel.closeStream({ threadId, registrationId: registered.registrationId });
        for (const terminal of input.reasons)
          notify({
            kind: terminal === "screen_locked" ? "pause" : "stop",
            threadId,
            controlId: "A",
            terminal,
          });
        yield* Deferred.succeed(admissionGate, undefined);
      } else if (kind === "retainedWaiter") {
        hold = true;
        const first = input.reasons[0];
        if (first === undefined) return yield* Effect.die("expected a terminal source");
        notify({
          kind: first === "screen_locked" ? "pause" : "stop",
          threadId,
          controlId: "A",
          terminal: first,
        });
        yield* Deferred.await(reading);
        for (const terminal of input.reasons.slice(1))
          notify({
            kind: terminal === "screen_locked" ? "pause" : "stop",
            threadId,
            controlId: "A",
            terminal,
          });
        yield* Deferred.succeed(release, undefined);
      }
      const answer = yield* Fiber.join(pending);
      if (answer._tag !== "Failure") return yield* Effect.die("expected channel refusal");
      return replaceWithTerminal(answer.failure);
    });

const proxyAdmission =
  (
    kind:
      | "duplicate"
      | "incompleteWindow"
      | "wrongDisplay"
      | "paused"
      | "noTicket"
      | "capture"
      | "finished",
  ) =>
  (input: Input) =>
    Effect.gen(function* () {
      let visible = false;
      const overlay = Object.assign(
        (command: { readonly op: "show" | "hide" | "status" }) =>
          Effect.sync(() => {
            if (command.op === "show") visible = true;
          }),
        { captureHideConfirmed: () => !visible },
      );
      const h = yield* harness({
        autoAppListing: true,
        ...(kind === "capture" ? { overlay } : {}),
        ...(kind === "incompleteWindow" || kind === "wrongDisplay"
          ? { elsewhere: new Set([900]) }
          : {}),
        ...(kind === "noTicket"
          ? {
              humanInput: true,
              onAgentInput: () => Effect.void,
              reservation: (request) =>
                Effect.succeed(
                  request.action === "reserve"
                    ? { status: "admitted", reservationId: null }
                    : { status: "released" },
                ),
            }
          : {}),
      });
      yield* h.push(active());
      if (kind === "duplicate") {
        yield* h.send(call(1, "list_apps"));
        yield* h.nextToDriver;
        yield* h.send(call(1, "list_apps"));
      } else if (kind === "paused") {
        yield* h.push({ state: "paused", controlId: CONTROL, reason: "takeover" });
        yield* h.send(call(1, "list_apps"));
      } else if (kind === "finished") {
        yield* h.push({ state: "ended", reason: "disabled" });
        yield* h.killed;
        yield* h.send(call(1, "list_apps"));
      } else if (kind === "capture") {
        yield* h.send(call(1, "click", { pid: 4, window_id: 9 }));
        yield* h.nextToDriver;
        yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } }));
        yield* h.nextToProvider;
        yield* h.send(call(2, "get_window_state", { pid: 4, window_id: 9 }));
      } else {
        const args =
          kind === "incompleteWindow"
            ? { window_id: 5 }
            : kind === "wrongDisplay"
              ? { pid: 900, window_id: 5 }
              : { pid: 4, window_id: 9 };
        yield* h.send(call(1, "click", args));
      }
      const answer = JSON.stringify(yield* h.nextToProvider);
      const detail =
        kind === "duplicate"
          ? "invalid_target"
          : kind === "finished"
            ? "disabled"
            : kind === "paused"
              ? "waiting_for_human"
              : kind === "noTicket"
                ? "unauthorized"
                : kind === "capture"
                  ? "capture_hide_unconfirmed"
                  : "wrong_display";
      assert.include(answer, `"detail":"${detail}"`);
      return finalize(answer, input);
    });

const cancelledPrimitive = (input: Input) =>
  Effect.gen(function* () {
    const h = yield* harness({ primitiveCancelled: () => true });
    yield* h.push(active());
    const current = yield* h.driverStarted;
    yield* h.sendPrimitive({
      state: "primitive-request",
      requestId: "cancelled",
      registrationId: "registration",
      controlId: CONTROL,
      connectionGeneration: current.connectionId,
      runId: "run",
      turnId: "turn",
      callId: 1,
      deadlineMillis: 60000,
      tool: "list_apps",
      args: {},
    });
    const reply = yield* h.primitiveReply;
    assert.include(JSON.stringify(reply), '"detail":"expired"');
    return finalize(JSON.stringify({ id: 1, result: reply.result }), input);
  });

const replacedAdmission = (input: Input) =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    yield* Effect.addFinalizer(() => Deferred.succeed(gate, undefined));
    const h = yield* harness({
      elsewhere: new Set([900]),
      placementGate: gate,
      autoAppListing: true,
    });
    yield* h.push(active());
    yield* h.send(call(1, "click", { pid: 10, window_id: 20, x: 1, y: 1 }));
    yield* h.checking;
    yield* h.push({ state: "paused", controlId: CONTROL, reason: "takeover" });
    yield* h.push(active());
    yield* h.restarted;
    yield* Deferred.succeed(gate, undefined);
    const asked = yield* h.nextToDriver;
    assert.deepInclude(asked, { params: { name: "list_windows", arguments: {} } });
    yield* h.reply(
      JSON.stringify({
        jsonrpc: "2.0",
        id: asked.id,
        result: { content: [], structuredContent: { windows: [{ pid: 10, window_id: 20 }] } },
      }),
    );
    const answer = JSON.stringify(yield* h.nextToProvider);
    assert.include(answer, '"detail":"waiting_for_human"');
    return finalize(answer, input);
  });

const unconfirmedProof = (input: Input) =>
  Effect.gen(function* () {
    const h = yield* harness({ elsewhere: new Set(), autoAppListing: true });
    yield* h.push(active());
    yield* h.send(call(1, "click", { pid: 4, window_id: 9 }));
    const asked = yield* h.nextToDriver;
    assert.deepInclude(asked, { params: { name: "list_windows", arguments: {} } });
    yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: asked.id, result: { isError: true } }));
    const answer = JSON.stringify(yield* h.nextToProvider);
    assert.include(answer, "could not confirm");
    return finalize(answer, input);
  });

const heldProof = (input: Input) =>
  Effect.gen(function* () {
    const h = yield* harness({ elsewhere: new Set(), transportHeld: () => true });
    yield* h.push(active());
    yield* h.send(call(1, "health_report"));
    const answer = JSON.stringify(yield* h.nextToProvider);
    assert.include(answer, '"detail":"reconnecting"');
    return finalize(answer, input);
  });

export const preDispatchSites: ReadonlyArray<{
  readonly name: string;
  readonly undispatched: true;
  readonly implicitReason?: ComputerUseTerminalReason;
  readonly run: (input: Input) => Effect.Effect<ComputerUseTerminalState, never, Scope.Scope>;
}> = [
  { name: "ComputerUseLeaseProxy.heldProof", undispatched: true, run: heldProof },
  { name: "ComputerUseLeaseProxy.unconfirmedProof", undispatched: true, run: unconfirmedProof },
  { name: "ComputerUseLeaseProxy.replacedAdmission", undispatched: true, run: replacedAdmission },
  { name: "ComputerUseLeaseProxyThread.reconnecting", undispatched: true, run: reconnecting },
  { name: "ComputerUseLeaseProxy.cancelledPrimitive", undispatched: true, run: cancelledPrimitive },
  {
    name: "ComputerUseLeaseProxy.duplicateId",
    undispatched: true,
    run: proxyAdmission("duplicate"),
  },
  {
    name: "ComputerUseLeaseProxy.incompleteWindow",
    undispatched: true,
    run: proxyAdmission("incompleteWindow"),
  },
  {
    name: "ComputerUseLeaseProxy.wrongDisplay",
    undispatched: true,
    run: proxyAdmission("wrongDisplay"),
  },
  { name: "ComputerUseLeaseProxy.paused", undispatched: true, run: proxyAdmission("paused") },
  { name: "ComputerUseLeaseProxy.noTicket", undispatched: true, run: proxyAdmission("noTicket") },
  { name: "ComputerUseLeaseProxy.captureHide", undispatched: true, run: proxyAdmission("capture") },
  { name: "ComputerUseLeaseProxy.finished", undispatched: true, run: proxyAdmission("finished") },
  {
    name: "ComputerUsePrimitiveChannel.retainedWaiter",
    undispatched: true,
    run: channelRefusal("retainedWaiter"),
  },
  {
    name: "ComputerUsePrimitiveChannel.authority",
    undispatched: true,
    run: channelRefusal("authority"),
  },
  {
    name: "ComputerUsePrimitiveChannel.activeRace",
    undispatched: true,
    run: channelRefusal("activeRace"),
  },
  {
    name: "ComputerUsePrimitiveChannel.activeRaceClosed",
    undispatched: true,
    run: channelRefusal("activeRaceClosed"),
  },
  {
    name: "ComputerUseLeaseProxyPersonStop.lockRefusal",
    undispatched: true,
    run: personFence("screen_locked"),
  },
  {
    name: "ComputerUseLeaseProxyPersonStop.stopRefusal",
    undispatched: true,
    implicitReason: "stopped_by_person" satisfies ComputerUseTerminalReason,
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
  {
    name: "ComputerUseLeaseProxyThread.transportLost",
    undispatched: true,
    run: supervisor("transportLost"),
  },
  { name: "ComputerUseLeaseProxyOptions.queuedDeadline", undispatched: true, run: deadline },
  { name: "ComputerUseLeaseProxyBatch.scope", undispatched: true, run: unsupported("batch") },
  { name: "ComputerUseLeaseProxyPointBasis.check", undispatched: true, run: unsupported("point") },
];
