import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type ComputerUsePrimitiveReply,
  type ComputerUsePrimitiveRequest,
  type ScreenHostCall,
  type ScreenRunError,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ComputerUseLeases from "./ComputerUseLeases.ts";
import * as PrimitiveChannel from "./ComputerUsePrimitiveChannel.ts";
import { active, call as proxyCall, CONTROL, harness } from "./ComputerUseLeaseProxy.testkit.ts";
import { snapshot, threadHarness } from "./ComputerUseLeaseProxyThread.testkit.ts";
import { parse } from "./ComputerUseLeaseProtocol.ts";
import {
  cutOff,
  offScreenAnswer,
  refusal,
  terminalReplacement,
  unsentCallRefusal,
  unsentOutcome,
} from "./ComputerUseLeaseResponses.ts";
import { finalTerminalLine, terminalSink } from "./ComputerUseLeaseProxyPersonStop.ts";
import {
  primitiveReplySink,
  rememberDriverReply,
  retainedTerminal,
  offScreenForRequest,
  type OutstandingCall,
} from "./ComputerUseLeaseProxyOptions.ts";
import {
  replaceWithTerminal,
  terminalFailure,
  terminalReplyState,
  type ComputerUseTerminalReason,
  type ComputerUseTerminalState,
} from "./ComputerUseTerminal.ts";
import {
  callTerminalError,
  cellTerminalError,
  completionCellError,
  finalScreenReply,
  cellFailureBase,
} from "../screenCode/ScreenActionOutcome.ts";
import { finishCellResponse, makeCellAuthority } from "../screenCode/ScreenCellAuthority.ts";
import { driverError } from "../screenCode/DesktopDriverReplies.ts";
import { driverOutcomeSafety } from "./ComputerUseDriverOutcome.ts";
import { ScreenHostBridge } from "../screenCode/ScreenHostBridge.ts";
import { makeProxyBrowserClaims } from "./ComputerUseLeaseProxyBrowserClaims.ts";
import { refuseProxyCall } from "./ComputerUseLeaseProxyRefusal.ts";
import { staleGeneration } from "./ComputerUseLeaseProxyPrimitive.ts";
import { screenRunLimits } from "../screenCode/ScreenRunLimits.ts";

type Input = { readonly possible: boolean; readonly reasons: readonly ComputerUseTerminalReason[] };
type Driver = (
  input: Input,
) => Effect.Effect<ComputerUseTerminalState, ScreenRunError, Scope.Scope>;
const inputState = (input: Input) =>
  terminalReplyState(
    {
      isError: true,
      structuredContent: { code: "unavailable", safety: { possibleCommit: input.possible } },
    },
    "settled",
  );
const sourceState = (input: Input) => replaceWithTerminal("none", ...input.reasons);
const merged = (input: Input) => replaceWithTerminal(inputState(input), ...input.reasons);
const outputState = (line: string, status: ComputerUsePrimitiveReply["status"] = "settled") =>
  replaceWithTerminal(terminalReplyState(parse(line)?.result, status));
const errorOf = (input: Input): ScreenRunError => ({
  code: "downstream_failure",
  effectStarted: input.possible,
  nextStep: "interrupted",
});
const call: ScreenHostCall = {
  t: "call",
  runId: "run",
  turnId: "turn",
  cellId: "cell",
  callId: 1,
  method: "list_apps",
  args: {},
  deadlineMillis: 30000,
};
const request: ComputerUsePrimitiveRequest = {
  state: "primitive-request",
  requestId: "request",
  registrationId: "registration",
  controlId: "control",
  connectionGeneration: "g",
  runId: "run",
  turnId: "turn",
  callId: 1,
  deadlineMillis: 30000,
  tool: "list_apps",
  args: {},
};
const message = (input: Input) =>
  JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: {
      isError: true,
      structuredContent: { code: "unavailable", safety: { possibleCommit: input.possible } },
    },
  });
const sync =
  (run: (input: Input) => ComputerUseTerminalState): Driver =>
  (input) =>
    Effect.sync(() => run(input));
const channel: Driver = (input) =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("matrix");
    const controlId = "control";
    const signals = yield* PubSub.unbounded<void>();
    let notify: Parameters<
      NonNullable<ComputerUseLeases.ComputerUseLeases["Service"]["onAuthorityChange"]>
    >[0] = () => {};
    const leases = yield* ComputerUseLeases.ComputerUseLeases.pipe(
      Effect.provide(
        Layer.mock(ComputerUseLeases.ComputerUseLeases)({
          proxy: undefined,
          currentControl: () =>
            Effect.succeedSome({ threadId, controlId, expiresAt: DateTime.makeUnsafe(60000) }),
          controlState: () =>
            Effect.succeed({
              _tag: "active",
              expiresAt: DateTime.makeUnsafe(60000),
              apps: undefined,
              wakeAt: 60000,
              interruptions: { count: 0, last: "screen_locked" },
            }),
          subscribe: PubSub.subscribe(signals),
          onAuthorityChange: (listener) => {
            notify = listener;
            return () => {};
          },
        }),
      ),
    );
    const service = yield* PrimitiveChannel.make.pipe(
      Effect.provideService(ComputerUseLeases.ComputerUseLeases, leases),
    );
    const authority = { threadId, attachmentGeneration: "a", proxyChannelToken: "fixture" };
    yield* service.issue({ ...authority, expiresAt: 60000 });
    const registered = yield* service.registerStream({
      ...authority,
      proxyInstanceId: "p",
      kind: "thread",
    });
    if (registered.status !== "registered") return yield* Effect.die("registration failed");
    yield* service.reportControlReady({
      ...authority,
      registrationId: registered.registrationId,
      controlId,
      connectionId: "g",
      driverGeneration: 1,
    });
    const pending = yield* service
      .request({
        threadId,
        runId: "run",
        turnId: "turn",
        callId: 1,
        deadlineMillis: 30000,
        tool: "list_apps",
        args: {},
      })
      .pipe(Effect.forkChild({ startImmediately: true }));
    const sent = Option.getOrThrow(yield* Stream.runHead(registered.requests));
    if (sent.state !== "primitive-request") return yield* Effect.die("missing request");
    for (const terminal of input.reasons)
      notify({
        kind: terminal === "screen_locked" ? "pause" : "stop",
        threadId,
        controlId,
        terminal,
      });
    yield* service.reply({
      ...authority,
      registrationId: registered.registrationId,
      reply: {
        ...sent,
        status: "unknown_outcome",
        result: {
          isError: true,
          structuredContent: { code: "unavailable", safety: { possibleCommit: input.possible } },
        },
      },
    });
    const result = yield* Fiber.join(pending);
    return replaceWithTerminal(terminalReplyState(result.result, result.status));
  });
const compact: Driver = (input) =>
  Effect.gen(function* () {
    let answer: ComputerUsePrimitiveReply | undefined;
    const sink = primitiveReplySink(request, (reply) =>
      Effect.sync(() => {
        answer = reply;
      }),
    );
    const oversized = JSON.stringify({
      result: {
        isError: true,
        structuredContent: { code: "unavailable", safety: { possibleCommit: input.possible } },
        content: [{ type: "text", text: "x".repeat(1024 * 1024) }],
      },
    });
    yield* sink.answer(oversized, "settled", { terminalState: () => sourceState(input) });
    return replaceWithTerminal(terminalReplyState(answer?.result, answer?.status));
  });
const proxy: Driver = (input) =>
  Effect.gen(function* () {
    let output = "";
    const sink = terminalSink(
      {
        answer: (line) =>
          Effect.sync(() => {
            output = line;
          }),
      },
      { id: 1, method: "tools/call", params: { name: "list_apps" } },
      () => sourceState(input).reason,
      () => false,
    );
    yield* sink.answer(message(input), "settled");
    return outputState(output);
  });
const received: Driver = (input) =>
  Effect.gen(function* () {
    const request: OutstandingCall = {
      id: 1,
      method: "tools/call",
      tool: "list_apps",
      connectionId: "g",
      sink: { answer: () => Effect.void },
    };
    const envelope = parse(message(input));
    if (envelope === undefined) return yield* Effect.die("invalid fixture");
    rememberDriverReply(request, envelope);
    return outputState(
      cutOff(
        1,
        "list_apps",
        { _tag: "other", detail: "wrong_display", message: "interrupted" },
        undefined,
        replaceWithTerminal(retainedTerminal(request), ...input.reasons),
      ),
    );
  });
const interruptedProxy: Driver = (input) =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
    const h = yield* harness({
      personStop: true,
      screenshots: {
        scrub: (line) => line,
        admit: (reply) =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(reply.line),
          ),
      },
    });
    yield* h.push(active());
    yield* h.driverStarted;
    yield* h.send(proxyCall(1, "list_apps"));
    yield* h.nextToDriver;
    const earlier = input.reasons.length > 1 ? input.reasons[0] : "unavailable";
    yield* h.reply(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          isError: true,
          structuredContent: {
            code: earlier,
            effect: "applied",
            safety: { possibleCommit: input.possible, retryClass: "never" },
          },
        },
      }),
    );
    yield* Deferred.await(entered);
    const last = input.reasons.at(-1);
    if (last === "stopped_by_person") {
      yield* h.escape;
      yield* h.escapeReported;
    } else yield* h.push({ state: "paused", controlId: CONTROL, reason: "screen_locked" });
    yield* h.killed;
    const result = yield* h.nextToProvider;
    return replaceWithTerminal(terminalReplyState(result.result));
  });
const threadProxy: Driver = (input) =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
    const h = yield* threadHarness({
      screenshots: {
        scrub: (line) => line,
        admit: (reply) =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(reply.line),
          ),
      },
    });
    yield* h.push(snapshot("A"));
    const driver = yield* h.started;
    yield* h.applied;
    yield* h.send(proxyCall(1, "list_apps"));
    yield* Queue.take(driver.sent);
    const earlier = input.reasons.length > 1 ? input.reasons[0] : "unavailable";
    yield* Queue.offer(
      driver.replies,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          isError: true,
          structuredContent: {
            code: earlier,
            effect: "applied",
            safety: { possibleCommit: input.possible, retryClass: "never" },
          },
        },
      }),
    );
    yield* Deferred.await(entered);
    const last = input.reasons.at(-1);
    if (last === "stopped_by_person")
      yield* h.push({ state: "control-ended", controlId: "A", reason: "stopped" });
    else yield* h.push({ ...snapshot("A"), state: "paused", reason: "screen_locked" });
    const result = yield* h.next;
    return replaceWithTerminal(terminalReplyState(result.result));
  });
const claims: Driver = (input) =>
  Effect.gen(function* () {
    let line = "";
    const request: OutstandingCall = {
      id: 1,
      method: "tools/call",
      tool: "list_apps",
      connectionId: "g",
      received: merged(input),
      sink: {
        answer: (value) =>
          Effect.sync(() => {
            line = value;
          }),
      },
    };
    yield* makeProxyBrowserClaims().refuseReply(
      request,
      "1",
      new Map([["1", request]]),
      () => false,
      () => Effect.void,
    );
    return outputState(line);
  });
const offScreen: Driver = (input) =>
  Effect.sync(() => {
    const request: OutstandingCall = {
      id: 1,
      method: "tools/call",
      tool: "list_apps",
      connectionId: "g",
      received: merged(input),
      sink: { answer: () => Effect.void },
    };
    return outputState(offScreenForRequest(request, "unknown"));
  });
const bridge: Driver = (input) =>
  Effect.gen(function* () {
    const host = new ScreenHostBridge();
    host.setDispatcher({
      availability: () => Effect.succeed([]),
      dispatch: () =>
        Effect.sync(() => {
          const result: import("../screenCode/ScreenHostBridge.ts").ScreenHostDispatchResult = {
            category: "confirmed",
            evidence: ["observed"],
            value: [],
            safety: {
              possibleCommit: input.possible,
              retryClass: "never",
              writeStatus: "committed",
              code: "write_committed",
            },
          };
          for (const reason of input.reasons) host.cutCellNow("run", "turn", "cell", reason);
          return result;
        }),
    });
    const context = {
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
    };
    const reply = yield* host.handle(call, context);
    return replaceWithTerminal(reply?.error ?? "none");
  });
const completion: Driver = (input) =>
  Effect.gen(function* () {
    const cells = makeCellAuthority(undefined);
    const terminals = new Map<string, ComputerUseTerminalReason>();
    yield* cells.begin("run", "cell", "thread");
    const reason = sourceState(input).reason;
    if (reason !== undefined) terminals.set("run", reason);
    const outcome = yield* Effect.fail(errorOf(input)).pipe(
      finishCellResponse({ id: "run", cellId: "cell", cells, terminals }),
      Effect.result,
    );
    if (outcome._tag !== "Failure") return yield* Effect.die("expected terminal failure");
    return replaceWithTerminal(outcome.failure);
  });
const unsentBase: Parameters<typeof unsentCallRefusal>[2] = {
  pending: undefined,
  finished: undefined,
  paused: undefined,
  idle: false,
  foregroundRevoked: false,
  lastInterruption: { _tag: "other", detail: "reconnecting", message: "reconnecting" },
};
const unsent = (state: Parameters<typeof unsentCallRefusal>[2]): Driver =>
  sync((input) =>
    outputState(
      finalTerminalLine(
        unsentCallRefusal(1, "tools/call", state),
        "not_started",
        { id: 1, method: "tools/call", params: { name: "list_apps" } },
        sourceState(input),
      ).line,
      "not_started",
    ),
  );
const unsentResult = (kind: "shared" | "expired"): Driver =>
  sync((input) =>
    outputState(
      finalTerminalLine(
        unsentOutcome(kind, 1, "tools/call", () => {
          throw new Error("unexpected stale outcome");
        }),
        "not_started",
        { id: 1, method: "tools/call", params: { name: "list_apps" } },
        sourceState(input),
      ).line,
      "not_started",
    ),
  );
const refusalBase: Parameters<typeof refuseProxyCall>[0] = {
  id: 1,
  message: { id: 1, method: "tools/call", params: { name: "list_apps" } },
  finished: () => undefined,
  paused: () => undefined,
  idle: () => false,
  apps: () => undefined,
  listed: new Map(),
  host: { bundleIds: false },
  shared: () => false,
  toFile: () => undefined,
  tokenFirstRefuses: () => false,
  foreground: () => [],
  listApps: Effect.void,
};
const proxyMessage = (name: string, args: object) =>
  parse(JSON.stringify({ id: 1, method: "tools/call", params: { name, arguments: args } })) ?? {};
const finalFresh = (line: string, input: Input) =>
  outputState(
    finalTerminalLine(
      line,
      "not_started",
      { id: 1, method: "tools/call", params: { name: "list_apps" } },
      sourceState(input),
    ).line,
    "not_started",
  );
const claimGate = (name: string, args: object, expected: string, authority?: "claimBind"): Driver =>
  sync((input) => {
    const claims = makeProxyBrowserClaims();
    claims.update({ ...active(), claimedBrowserPids: [55] });
    const message = proxyMessage(name, args);
    const gated = claims.gate(1, JSON.stringify(message), message, authority);
    if (!("refused" in gated)) throw new Error(`expected a claim refusal: ${expected}`);
    assert.include(gated.refused, expected);
    return finalFresh(gated.refused, input);
  });
const proxyRefusal =
  (overrides: Partial<Parameters<typeof refuseProxyCall>[0]>, detail: string): Driver =>
  (input) =>
    Effect.gen(function* () {
      const line = yield* refuseProxyCall({ ...refusalBase, ...overrides });
      if (line === undefined) return yield* Effect.die("expected a proxy refusal");
      assert.include(line, `"detail":"${detail}"`);
      return outputState(
        finalTerminalLine(
          line,
          "not_started",
          { id: 1, method: "tools/call", params: { name: "list_apps" } },
          sourceState(input),
        ).line,
        "not_started",
      );
    });
const sites: ReadonlyArray<{
  readonly name: string;
  readonly run: Driver;
  readonly undispatched?: boolean;
}> = [
  {
    name: "ComputerUseLeaseProxyPrimitive.staleGeneration",
    undispatched: true,
    run: sync((input) => finalFresh(staleGeneration(1, "tools/call"), input)),
  },
  {
    name: "ComputerUseLeaseProxyBrowserClaims.gate.bind",
    undispatched: true,
    run: claimGate("get_browser_state", {}, "no approved pending claim", "claimBind"),
  },
  {
    name: "ComputerUseLeaseProxyBrowserClaims.gate.untrusted",
    undispatched: true,
    run: claimGate("get_browser_state", { authority: "claimBind" }, "host-only"),
  },
  {
    name: "ComputerUseLeaseProxyBrowserClaims.gate.unclaimed",
    undispatched: true,
    run: claimGate("get_browser_state", {}, "no approved claim"),
  },
  {
    name: "ComputerUseLeaseProxyBrowserClaims.gate.desktop",
    undispatched: true,
    run: claimGate("get_window_state", { pid: 55, window_id: 7 }, "Desktop access"),
  },
  {
    name: "ComputerUseLeaseProxyRefusal.finished",
    undispatched: true,
    run: proxyRefusal({ finished: () => "expired" }, "expired"),
  },
  {
    name: "ComputerUseLeaseProxyRefusal.paused",
    undispatched: true,
    run: proxyRefusal({ paused: () => "screen_locked" }, "screen_locked"),
  },
  {
    name: "ComputerUseLeaseProxyRefusal.idle",
    undispatched: true,
    run: proxyRefusal({ idle: () => true }, "control_idle"),
  },
  {
    name: "ComputerUseLeaseProxyRefusal.desktopCapture",
    undispatched: true,
    run: proxyRefusal(
      {
        message: { id: 1, method: "tools/call", params: { name: "get_desktop_state" } },
      },
      "desktop_capture_off",
    ),
  },
  {
    name: "ComputerUseLeaseProxyRefusal.toFile",
    undispatched: true,
    run: proxyRefusal({ toFile: () => "capture unavailable" }, "desktop_capture_off"),
  },
  {
    name: "ComputerUseLeaseProxyRefusal.tokenFirst",
    undispatched: true,
    run: proxyRefusal({ tokenFirstRefuses: () => true }, "token_first"),
  },
  {
    name: "ComputerUseLeaseProxyRefusal.scopeResolve",
    undispatched: true,
    run: proxyRefusal(
      {
        message: proxyMessage("click", { pid: 55 }),
        apps: () => new Set(["approved"]),
      },
      "app_not_allowed",
    ),
  },
  {
    name: "ComputerUseLeaseProxyRefusal.foregroundBeforeScopeResolve",
    undispatched: true,
    run: proxyRefusal(
      {
        message: proxyMessage("click", { pid: 55, delivery_mode: "foreground" }),
        apps: () => new Set(["approved"]),
      },
      "foreground_not_approved",
    ),
  },
  {
    name: "ComputerUseLeaseProxyRefusal.batchMissing",
    undispatched: true,
    run: proxyRefusal(
      { message: proxyMessage("run_steps", { app_scope: { apps: ["missing"] }, steps: [] }) },
      "app_not_allowed",
    ),
  },
  {
    name: "ComputerUseLeaseProxyRefusal.scopeRefuse",
    undispatched: true,
    run: proxyRefusal(
      {
        message: proxyMessage("click", { pid: 55 }),
        apps: () => new Set(["approved"]),
        listed: new Map([[55, { id: "other", name: "Other" }]]),
      },
      "app_not_approved",
    ),
  },
  {
    name: "ComputerUseLeaseProxyRefusal.screenShared",
    undispatched: true,
    run: proxyRefusal(
      {
        message: proxyMessage("bring_to_front", { pid: 55, window_id: 7 }),
        listed: new Map([[55, { id: "other", name: "Other" }]]),
        shared: () => true,
      },
      "screen_shared",
    ),
  },
  {
    name: "ComputerUseLeaseProxyRefusal.foreground",
    undispatched: true,
    run: proxyRefusal(
      {
        message: proxyMessage("bring_to_front", { pid: 55, window_id: 7 }),
        listed: new Map([[55, { id: "other", name: "Other" }]]),
      },
      "foreground_not_approved",
    ),
  },
  {
    name: "ComputerUseLeaseResponses.unsentCallRefusal.ending",
    undispatched: true,
    run: unsent({ ...unsentBase, finished: "expired" }),
  },
  {
    name: "ComputerUseLeaseResponses.unsentCallRefusal.pause",
    undispatched: true,
    run: unsent({ ...unsentBase, paused: "screen_locked" }),
  },
  {
    name: "ComputerUseLeaseResponses.unsentCallRefusal.idle",
    undispatched: true,
    run: unsent({ ...unsentBase, idle: true }),
  },
  {
    name: "ComputerUseLeaseResponses.unsentCallRefusal.held",
    undispatched: true,
    run: unsent({ ...unsentBase, held: true }),
  },
  {
    name: "ComputerUseLeaseResponses.unsentCallRefusal.narrowed",
    undispatched: true,
    run: unsent({ ...unsentBase, pending: { narrowed: true } }),
  },
  {
    name: "ComputerUseLeaseResponses.unsentCallRefusal.foregroundRevoked",
    undispatched: true,
    run: unsent({ ...unsentBase, foregroundRevoked: true }),
  },
  {
    name: "ComputerUseLeaseResponses.unsentCallRefusal.interrupted",
    undispatched: true,
    run: unsent(unsentBase),
  },
  {
    name: "ComputerUseLeaseResponses.unsentOutcome.shared",
    undispatched: true,
    run: unsentResult("shared"),
  },
  {
    name: "ComputerUseLeaseResponses.unsentOutcome.expired",
    undispatched: true,
    run: unsentResult("expired"),
  },
  { name: "ComputerUseTerminal.replaceWithTerminal", run: sync((input) => merged(input)) },
  {
    name: "ComputerUseTerminal.terminalFailure",
    run: sync((input) =>
      replaceWithTerminal(terminalFailure(merged(input), "list_apps", {}, false) ?? "none"),
    ),
  },
  {
    name: "ComputerUseLeaseResponses.refusal",
    run: sync((input) =>
      outputState(refusal(merged(input), 1, "tools/call", "wrong_display", "wrong display")),
    ),
  },
  {
    name: "ComputerUseLeaseResponses.cutOff",
    run: sync((input) =>
      outputState(
        cutOff(
          1,
          "list_apps",
          { _tag: "other", detail: "wrong_display", message: "interrupted" },
          undefined,
          merged(input),
        ),
      ),
    ),
  },
  {
    name: "ComputerUseLeaseResponses.terminalReplacement",
    run: sync((input) =>
      outputState(terminalReplacement(1, "list_apps", {}, merged(input), false)),
    ),
  },
  {
    name: "ComputerUseLeaseResponses.offScreenAnswer",
    run: sync((input) =>
      outputState(offScreenAnswer(1, "tools/call", "list_apps", "unknown", {}, merged(input))),
    ),
  },
  {
    name: "ComputerUseLeaseProxyPersonStop.finalTerminalLine",
    run: sync((input) =>
      outputState(
        finalTerminalLine(
          message(input),
          "settled",
          { id: 1, method: "tools/call", params: { name: "list_apps" } },
          sourceState(input),
        ).line,
      ),
    ),
  },
  { name: "ComputerUseLeaseProxyPersonStop.terminalSink", run: proxy },
  { name: "ComputerUseLeaseProxy.interrupt", run: interruptedProxy },
  { name: "ComputerUseLeaseProxyThread.output", run: threadProxy },
  { name: "ComputerUseLeaseProxyOptions.retainedTerminal", run: received },
  { name: "ComputerUseLeaseProxy.offScreenForRequest", run: offScreen },
  { name: "ComputerUseLeaseProxyBrowserClaims.refuseReply", run: claims },
  { name: "ComputerUseLeaseProxyOptions.primitiveReplySink", run: compact },
  { name: "ComputerUsePrimitiveChannel.replyAndSettle", run: channel },
  {
    name: "ComputerUseDriverOutcome.driverOutcomeSafety",
    run: sync((input) => {
      const reason = sourceState(input).reason;
      if (reason === undefined) throw new Error("Expected a terminal reason.");
      const reply = {
        status: "settled",
        result: {
          isError: true,
          structuredContent: { code: reason, safety: { possibleCommit: input.possible } },
        },
      };
      return replaceWithTerminal(driverOutcomeSafety("list_apps", reply), reason);
    }),
  },
  {
    name: "DesktopDriverReplies.driverError",
    run: sync((input) => {
      const reason = sourceState(input).reason;
      if (reason === undefined) throw new Error("Expected a terminal reason.");
      const reply: ComputerUsePrimitiveReply = {
        ...request,
        status: "unknown_outcome",
        result: {
          isError: true,
          structuredContent: { code: reason, safety: { possibleCommit: input.possible } },
        },
      };
      const error = driverError(reply);
      const safety = driverOutcomeSafety("list_apps", reply);
      return error === undefined
        ? replaceWithTerminal("none", safety)
        : replaceWithTerminal({ ...error, safety, effectStarted: safety.possibleCommit });
    }),
  },
  {
    name: "ScreenActionOutcome.cellFailureBase",
    run: sync((input) =>
      replaceWithTerminal(cellFailureBase(sourceState(input).reason, errorOf(input)) ?? "none"),
    ),
  },
  {
    name: "ScreenActionOutcome.callTerminalError",
    run: sync((input) =>
      replaceWithTerminal(
        callTerminalError(errorOf(input), sourceState(input).reason, call, false) ?? "none",
      ),
    ),
  },
  {
    name: "ScreenActionOutcome.finalScreenReply",
    run: sync((input) =>
      replaceWithTerminal(
        finalScreenReply(
          {
            t: "reply",
            runId: "run",
            cellId: "cell",
            callId: 1,
            outcome: "error",
            error: errorOf(input),
          },
          call,
          sourceState(input).reason,
          [],
        )?.error ?? "none",
      ),
    ),
  },
  { name: "ScreenHostBridge.closedResult", run: bridge },
  {
    name: "ScreenActionOutcome.cellTerminalError",
    run: sync((input) =>
      replaceWithTerminal(cellTerminalError(errorOf(input), [], sourceState(input).reason)),
    ),
  },
  {
    name: "ScreenActionOutcome.completionCellError",
    run: sync((input) =>
      replaceWithTerminal(
        completionCellError(errorOf(input), [], sourceState(input).reason) ?? "none",
      ),
    ),
  },
  { name: "ScreenCellAuthority.finishCellResponse", run: completion },
];
const orders: ReadonlyArray<{
  readonly name: string;
  readonly reasons: readonly ComputerUseTerminalReason[];
}> = [
  { name: "stop", reasons: ["stopped_by_person"] },
  { name: "lock", reasons: ["screen_locked"] },
  { name: "lock then stop", reasons: ["screen_locked", "stopped_by_person"] },
  { name: "stop then lock", reasons: ["stopped_by_person", "screen_locked"] },
];
const matrix = sites.flatMap((site) =>
  (site.undispatched === true ? [false] : [false, true]).flatMap((possible) =>
    orders.map((order) => ({ site, possible, order })),
  ),
);
it.effect.each(matrix)(
  "$site.name preserves input=$possible under $order.name",
  ({ site, possible, order }) =>
    Effect.gen(function* () {
      const actual = yield* site.run({ possible, reasons: order.reasons });
      assert.equal(
        actual.reason,
        order.reasons.includes("stopped_by_person") ? "stopped_by_person" : "screen_locked",
      );
      assert.equal(actual.possibleCommit, possible);
    }),
);
