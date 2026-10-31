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
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ComputerUseLeases from "./ComputerUseLeases.ts";
import * as PrimitiveChannel from "./ComputerUsePrimitiveChannel.ts";
import { parse } from "./ComputerUseLeaseProtocol.ts";
import {
  cutOff,
  offScreenAnswer,
  refusal,
  terminalReplacement,
} from "./ComputerUseLeaseResponses.ts";
import { finalTerminalLine, terminalSink } from "./ComputerUseLeaseProxyPersonStop.ts";
import {
  primitiveReplySink,
  rememberDriverReply,
  retainedTerminal,
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
const sites: ReadonlyArray<{ readonly name: string; readonly run: Driver }> = [
  { name: "replaceWithTerminal", run: sync((input) => merged(input)) },
  {
    name: "terminalFailure",
    run: sync((input) =>
      replaceWithTerminal(terminalFailure(merged(input), "list_apps", {}, false) ?? "none"),
    ),
  },
  {
    name: "refusal",
    run: sync((input) =>
      outputState(refusal(merged(input), 1, "tools/call", "wrong_display", "wrong display")),
    ),
  },
  {
    name: "cutOff",
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
    name: "terminalReplacement",
    run: sync((input) =>
      outputState(terminalReplacement(1, "list_apps", {}, merged(input), false)),
    ),
  },
  {
    name: "offScreenAnswer",
    run: sync((input) =>
      outputState(offScreenAnswer(1, "tools/call", "list_apps", "unknown", {}, merged(input))),
    ),
  },
  {
    name: "finalTerminalLine",
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
  { name: "terminalSink", run: proxy },
  { name: "received proxy cutoff", run: received },
  { name: "bounded primitive reply", run: compact },
  { name: "primitive reply settlement", run: channel },
  {
    name: "desktop driver reply",
    run: sync((input) => {
      const reason = sourceState(input).reason;
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
    name: "cellFailureBase",
    run: sync((input) =>
      replaceWithTerminal(cellFailureBase(sourceState(input).reason, errorOf(input)) ?? "none"),
    ),
  },
  {
    name: "callTerminalError",
    run: sync((input) =>
      replaceWithTerminal(
        callTerminalError(errorOf(input), sourceState(input).reason, call, false) ?? "none",
      ),
    ),
  },
  {
    name: "finalScreenReply",
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
  { name: "bridge closed result", run: bridge },
  {
    name: "cellTerminalError",
    run: sync((input) =>
      replaceWithTerminal(cellTerminalError(errorOf(input), [], sourceState(input).reason)),
    ),
  },
  {
    name: "completionCellError",
    run: sync((input) =>
      replaceWithTerminal(
        completionCellError(errorOf(input), [], sourceState(input).reason) ?? "none",
      ),
    ),
  },
  { name: "finishCellResponse", run: completion },
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
  [false, true].flatMap((possible) => orders.map((order) => ({ site, possible, order }))),
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
