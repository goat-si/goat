/**
 * The control stream a computer use proxy holds open: the current state of the control it was
 * started with, then a new line whenever that may have changed, ending with the line that ends
 * it. It authenticates with the thread's own GOAT MCP credential, so a proxy only ever learns
 * about its own thread. A POST to the same route reports, for that thread's live control only,
 * the window the proxy's latest admitted call named, its own input calls, or a person's input
 * its helper saw.
 *
 * @module ComputerUseLeaseRoute
 */
import {
  COMPUTER_USE_LEASE_ROUTE,
  ComputerUseLeaseReport,
  ComputerUseLeaseUpdate,
  ComputerUseCallReservation,
  ComputerUseCallAdmission,
} from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ComputerUseLeases from "./ComputerUseLeases.ts";

const encodeUpdate = Schema.encodeSync(Schema.fromJsonString(ComputerUseLeaseUpdate));
const encodeAdmission = Schema.encodeSync(Schema.fromJsonString(ComputerUseCallAdmission));
const decodeReservation = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ComputerUseCallReservation),
);

/** Updates for one thread's control until one of them ends it. */
export const leaseUpdates = (input: {
  readonly threadId: import("@goat/contracts").ThreadId;
  readonly controlId: string;
}) =>
  Stream.callback<
    ComputerUseLeaseUpdate,
    never,
    ComputerUseLeases.ComputerUseLeases | ServerSettings.ServerSettingsService
  >((queue) =>
    Effect.gen(function* () {
      const leases = yield* ComputerUseLeases.ComputerUseLeases;
      const settings = yield* ServerSettings.ServerSettingsService;
      const wake = yield* Queue.sliding<void>(1);
      const subscription = yield* leases.subscribe;
      yield* PubSub.take(subscription).pipe(
        Effect.andThen(Queue.offer(wake, undefined)),
        Effect.forever,
        Effect.forkScoped,
      );
      yield* (yield* settings.subscribeChanges).pipe(
        Stream.runForEach(() => Queue.offer(wake, undefined)),
        Effect.forkScoped,
      );
      for (;;) {
        const enabled = yield* settings.getSettings.pipe(
          Effect.map((value) => value.enableCua),
          Effect.orElseSucceed(() => false),
        );
        const state = enabled
          ? yield* leases.controlState(input.threadId, input.controlId).pipe(
              Effect.orElseSucceed((): ComputerUseLeases.ComputerUseControlState => ({
                _tag: "ended",
                reason: "revoked",
              })),
            )
          : undefined;
        if (state === undefined || state._tag === "ended") {
          yield* Queue.offer(queue, {
            state: "ended",
            reason: state === undefined ? "disabled" : state.reason,
          });
          return yield* Queue.end(queue);
        }
        if (state._tag === "paused") {
          yield* Queue.offer(queue, {
            state: "paused",
            controlId: input.controlId,
            reason: state.reason,
          });
          yield* Queue.take(wake);
          continue;
        }
        yield* Queue.offer(
          queue,
          state.idle === true
            ? {
                state: "idle",
                controlId: input.controlId,
              }
            : {
                state: "active",
                controlId: input.controlId,
                expiresAt: DateTime.formatIso(state.expiresAt),
                ...(state.apps === undefined ? {} : { apps: state.apps }),
                ...(state.idleEpoch === undefined ? {} : { idleEpoch: state.idleEpoch }),
                ...(state.interruptions.count === 0 ? {} : { interruptions: state.interruptions }),
                ...(state.shared === true ? { shared: true } : {}),
              },
        );
        const remaining = state.wakeAt - (yield* Clock.currentTimeMillis);
        yield* Effect.raceFirst(Queue.take(wake), Effect.sleep(Math.max(0, remaining)));
      }
    }),
  );

/** The thread a proxy's MCP credential belongs to, or undefined. */
const threadOf = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const registry = yield* McpSessionRegistry.McpSessionRegistry;
  const authorization = request.headers.authorization;
  const token =
    authorization?.startsWith("Bearer ") === true
      ? authorization.slice("Bearer ".length).trim()
      : "";
  const invocation = token.length === 0 ? undefined : yield* registry.resolve(token);
  return invocation?.thread?.threadId;
});

const decodeReport = Schema.decodeUnknownEffect(Schema.fromJsonString(ComputerUseLeaseReport));

/**
 * The window a proxy's latest admitted call named (#1370), or a person's own input (#1235). A
 * report for a control that is not the thread's live one, such as an old proxy's after its
 * control was replaced, changes nothing.
 */
export const reportLayer = HttpRouter.add(
  "POST",
  COMPUTER_USE_LEASE_ROUTE,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const threadId = yield* threadOf;
    if (threadId === undefined) return HttpServerResponse.empty({ status: 401 });
    const report = yield* request.text.pipe(Effect.flatMap(decodeReport), Effect.option);
    if (Option.isNone(report)) return HttpServerResponse.empty({ status: 400 });
    const leases = yield* ComputerUseLeases.ComputerUseLeases;
    const value = report.value;
    if ("humanInput" in value) {
      const outcome = yield* leases.humanInput(
        threadId,
        value.controlId,
        Array.isArray(value.humanInput) ? value.humanInput : [value.humanInput],
      );
      // 204 only when it paused the agents: the proxy stops reporting for that helper then, and
      // keeps reporting after a 202 (another agent's input) or a 409.
      return HttpServerResponse.empty({
        status: outcome === "paused" ? 204 : outcome === "agents" ? 202 : 409,
      });
    }
    const recorded =
      "agentInput" in value
        ? yield* leases.agentInput(threadId, value.controlId, value.agentInput)
        : yield* leases.setTarget(threadId, value.controlId, value);
    return HttpServerResponse.empty({ status: recorded ? 204 : 409 });
  }),
);

const streamLayer = HttpRouter.add(
  "GET",
  COMPUTER_USE_LEASE_ROUTE,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const threadId = yield* threadOf;
    const controlId = new URL(request.url, "http://local").searchParams.get("control");
    if (threadId === undefined || !controlId)
      return HttpServerResponse.text(
        encodeUpdate({ state: "ended", reason: "unauthorized" }) + "\n",
        { status: 401, contentType: "application/x-ndjson" },
      );
    const context = yield* Effect.context<
      ComputerUseLeases.ComputerUseLeases | ServerSettings.ServerSettingsService
    >();
    return HttpServerResponse.stream(
      leaseUpdates({ threadId, controlId }).pipe(
        Stream.map((update) => encodeUpdate(update) + "\n"),
        Stream.encodeText,
        Stream.provideContext(context),
      ),
      { contentType: "application/x-ndjson", headers: { "cache-control": "no-store" } },
    );
  }),
);

const callLayer = HttpRouter.add(
  "POST",
  `${COMPUTER_USE_LEASE_ROUTE}/calls`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const threadId = yield* threadOf;
    if (threadId === undefined) return HttpServerResponse.empty({ status: 401 });
    const call = yield* request.text.pipe(Effect.flatMap(decodeReservation), Effect.option);
    if (Option.isNone(call)) return HttpServerResponse.empty({ status: 400 });
    const leases = yield* ComputerUseLeases.ComputerUseLeases;
    const result = yield* leases.callReservation(threadId, call.value).pipe(
      Effect.orElseSucceed((): ComputerUseCallAdmission => ({
        status: "refused",
        detail: "unauthorized",
      })),
    );
    return HttpServerResponse.text(encodeAdmission(result), {
      contentType: "application/json",
      headers: { "cache-control": "no-store" },
    });
  }),
);

export const layer = Layer.mergeAll(streamLayer, reportLayer, callLayer);
