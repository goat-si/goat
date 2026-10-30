/**
 * A proxy can follow one control until it ends, or follow its thread across controls, waiting
 * between them. Both streams authenticate with the thread's own GOAT MCP credential, so a
 * proxy only ever learns about its own thread. A POST reports, for that thread's live control only,
 * the window the proxy's latest admitted call named, its own input calls, or a person's input
 * its helper saw.
 *
 * @module ComputerUseLeaseRoute
 */
import {
  COMPUTER_USE_LEASE_ROUTE,
  ComputerUseLeaseReport,
  ComputerUseLeaseUpdate,
  ComputerUseLeaseThreadUpdate,
  ComputerUseCallReservation,
  ComputerUseCallAdmission,
  COMPUTER_USE_PRIMITIVE_REPLY_ROUTE,
  COMPUTER_USE_PRIMITIVE_CONTROL_READY_ROUTE,
  COMPUTER_USE_PRIMITIVE_CONTROL_CUTOFF_ROUTE,
  ComputerUsePrimitiveReply,
  ComputerUsePrimitiveControlReady,
  ComputerUsePrimitiveControlCutoff,
  DEFAULT_SCREEN_RUN_LIMITS,
  COMPUTER_USE_PRIMITIVE_RESULT_BYTES,
} from "@goat/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import {
  HttpIncomingMessage,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ComputerUseAgentConnections from "./ComputerUseAgentConnections.ts";
import * as ComputerUseLeases from "./ComputerUseLeases.ts";
import * as ComputerUsePrimitiveChannel from "./ComputerUsePrimitiveChannel.ts";
import { threadLeaseUpdates, withPrimitiveRequests } from "./ComputerUseLeaseThreadStream.ts";
import { LEASE_HEARTBEAT_HEADER, LEASE_HEARTBEAT_MS } from "./ComputerUseLeaseStreamFollower.ts";
import { movesPersonPointer } from "./ComputerUsePointerPolicy.ts";
import { makeComputerUseHistory } from "./ComputerUseHistory.ts";
import { recordCallOutcome } from "./ComputerUseHistoryReport.ts";

const encodeUpdate = Schema.encodeSync(Schema.fromJsonString(ComputerUseLeaseUpdate));
const encodeThreadUpdate = Schema.encodeSync(Schema.fromJsonString(ComputerUseLeaseThreadUpdate));
const encodeAdmission = Schema.encodeSync(Schema.fromJsonString(ComputerUseCallAdmission));
const decodeReservation = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ComputerUseCallReservation),
);
const decodePrimitiveReply = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ComputerUsePrimitiveReply),
);
const PRIMITIVE_REPLY_BODY_BYTES =
  Math.ceil(DEFAULT_SCREEN_RUN_LIMITS.imageBytes / 3) * 4 +
  COMPUTER_USE_PRIMITIVE_RESULT_BYTES +
  128 * 1024;

/**
 * A blank line while state is quiet, which every proxy skips: it keeps idle timeouts on the way
 * (undici's five-minute body timeout among them) from closing a healthy stream, and lets a proxy
 * that knows the interval tell a dead connection from a quiet one.
 */
const withHeartbeat = <E, R>(lines: Stream.Stream<string, E, R>) =>
  Stream.merge(
    lines,
    Stream.tick(LEASE_HEARTBEAT_MS).pipe(
      Stream.drop(1),
      Stream.map(() => "\n"),
    ),
    { haltStrategy: "left" },
  );
const STREAM_HEADERS = {
  "cache-control": "no-store",
  [LEASE_HEARTBEAT_HEADER]: String(LEASE_HEARTBEAT_MS),
};
const decodeControlReady = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ComputerUsePrimitiveControlReady),
);
const decodeControlCutoff = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ComputerUsePrimitiveControlCutoff),
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
      // The proxy reading this exited, crashed or lost its connection: its app leases end (D17).
      yield* leases.streamOpened(input.controlId);
      yield* Effect.addFinalizer(() => leases.releaseApps(input.threadId, input.controlId));
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
                ...(state.foreground === undefined ? {} : { foreground: state.foreground }),
                ...(state.interruptions.count === 0 ? {} : { interruptions: state.interruptions }),
                ...(state.shared === true ? { shared: true } : {}),
              },
        );
        const remaining = state.wakeAt - (yield* Clock.currentTimeMillis);
        yield* Effect.raceFirst(Queue.take(wake), Effect.sleep(Math.max(0, remaining)));
      }
    }),
  );

const bearer = (authorization: string | undefined) =>
  authorization?.startsWith("Bearer ") === true ? authorization.slice("Bearer ".length).trim() : "";

/** The thread a proxy's MCP credential belongs to, or undefined. */
const threadOf = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const registry = yield* McpSessionRegistry.McpSessionRegistry;
  const authorization = request.headers.authorization;
  const token = bearer(authorization);
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
    const value = report.value;
    if ("driverEnded" in value) {
      const connections = yield* Effect.serviceOption(
        ComputerUseAgentConnections.ComputerUseAgentConnections,
      );
      if (Option.isSome(connections))
        yield* connections.value.report(
          value.driverEnded === false ? false : { reason: value.driverEnded.reason },
        );
      return HttpServerResponse.empty({ status: 204 });
    }
    const leases = yield* ComputerUseLeases.ComputerUseLeases;
    if ("type" in value) {
      if (!(yield* leases.ownsControl(threadId, value.controlId)))
        return HttpServerResponse.empty({ status: 409 });
      const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
      if (Option.isNone(sql)) return HttpServerResponse.empty({ status: 503 });
      const history = yield* makeComputerUseHistory.pipe(
        Effect.provideService(SqlClient.SqlClient, sql.value),
      );
      // The shared thread credential cannot attest that the target field is non-secret.
      const saved = yield* recordCallOutcome(history, threadId, value, false).pipe(Effect.option);
      return HttpServerResponse.empty({ status: Option.isSome(saved) ? 204 : 503 });
    }
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
    // Untraced like its request (http.ts): a pointer streaming moves reports many times a second.
  }).pipe(Effect.withTracerEnabled(false)),
);

const streamLayer = HttpRouter.add(
  "GET",
  COMPUTER_USE_LEASE_ROUTE,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const threadId = yield* threadOf;
    const params = new URL(request.url, "http://local").searchParams;
    const controlId = params.get("control");
    const primitive = params.get("primitive") === "1";
    const instance = params.get("instance");
    const channel = Option.getOrUndefined(
      yield* Effect.serviceOption(ComputerUsePrimitiveChannel.ComputerUsePrimitiveChannel),
    );
    const token = request.headers["x-goat-proxy-channel"] ?? "";
    const attachmentGeneration =
      threadId === undefined || !primitive || channel === undefined
        ? undefined
        : yield* channel.authenticate({ threadId, proxyChannelToken: token });
    if (primitive && (threadId === undefined || attachmentGeneration === undefined || !instance))
      return HttpServerResponse.empty({ status: 401 });
    if (params.has("thread")) {
      if (threadId === undefined || params.get("thread") !== threadId)
        return HttpServerResponse.text(
          encodeUpdate({ state: "ended", reason: "unauthorized" }) + "\n",
          { status: 401, contentType: "application/x-ndjson" },
        );
      if (params.size !== (primitive ? 3 : 1)) return HttpServerResponse.empty({ status: 400 });
      const registration =
        primitive &&
        channel !== undefined &&
        attachmentGeneration !== undefined &&
        instance !== null
          ? yield* channel.registerStream({
              threadId,
              attachmentGeneration,
              proxyChannelToken: token,
              proxyInstanceId: instance,
              kind: "thread",
            })
          : undefined;
      if (registration?.status === "unauthorized") return HttpServerResponse.empty({ status: 401 });
      if (registration?.status === "conflict") return HttpServerResponse.empty({ status: 409 });
      const context = yield* Effect.context<
        | ComputerUseLeases.ComputerUseLeases
        | ServerSettings.ServerSettingsService
        | McpSessionRegistry.McpSessionRegistry
      >();
      return HttpServerResponse.stream(
        withPrimitiveRequests(
          threadLeaseUpdates({ threadId, token: bearer(request.headers.authorization) }),
          registration?.status === "registered" ? registration.requests : undefined,
        ).pipe(
          Stream.map((update) => encodeThreadUpdate(update) + "\n"),
          withHeartbeat,
          Stream.encodeText,
          Stream.provideContext(context),
          Stream.ensuring(
            channel !== undefined && registration?.status === "registered"
              ? channel.closeStream({ threadId, registrationId: registration.registrationId })
              : Effect.void,
          ),
        ),
        {
          contentType: "application/x-ndjson",
          headers: {
            ...STREAM_HEADERS,
            ...(registration?.status === "registered"
              ? { "x-goat-primitive-registration": registration.registrationId }
              : {}),
          },
        },
      );
    }
    if (threadId === undefined || !controlId)
      return HttpServerResponse.text(
        encodeUpdate({ state: "ended", reason: "unauthorized" }) + "\n",
        { status: 401, contentType: "application/x-ndjson" },
      );
    if (params.size !== (primitive ? 3 : 1)) return HttpServerResponse.empty({ status: 400 });
    const registration =
      primitive && channel !== undefined && attachmentGeneration !== undefined && instance !== null
        ? yield* channel.registerStream({
            threadId,
            attachmentGeneration,
            proxyChannelToken: token,
            proxyInstanceId: instance,
            kind: "control",
            controlId,
          })
        : undefined;
    if (registration?.status === "unauthorized") return HttpServerResponse.empty({ status: 401 });
    if (registration?.status === "conflict") return HttpServerResponse.empty({ status: 409 });
    const context = yield* Effect.context<
      ComputerUseLeases.ComputerUseLeases | ServerSettings.ServerSettingsService
    >();
    return HttpServerResponse.stream(
      withPrimitiveRequests(
        leaseUpdates({ threadId, controlId }),
        registration?.status === "registered" ? registration.requests : undefined,
      ).pipe(
        Stream.map((update) => encodeUpdate(update) + "\n"),
        withHeartbeat,
        Stream.encodeText,
        Stream.provideContext(context),
        Stream.ensuring(
          channel !== undefined && registration?.status === "registered"
            ? channel.closeStream({ threadId, registrationId: registration.registrationId })
            : Effect.void,
        ),
      ),
      {
        contentType: "application/x-ndjson",
        headers: {
          ...STREAM_HEADERS,
          ...(registration?.status === "registered"
            ? { "x-goat-primitive-registration": registration.registrationId }
            : {}),
        },
      },
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
    // Unreadable settings keep the default: the person's pointer stays still.
    const movePointer = yield* ServerSettings.ServerSettingsService.pipe(
      Effect.flatMap((settings) => settings.getSettings),
      Effect.map((settings) => settings.cuaMovePointer),
      Effect.orElseSucceed(() => "never" as const),
    );
    if (
      call.value.action === "reserve" &&
      movePointer !== "allowed" &&
      movesPersonPointer(call.value)
    )
      return HttpServerResponse.text(
        encodeAdmission({ status: "refused", detail: "pointer_locked" }),
        { contentType: "application/json", headers: { "cache-control": "no-store" } },
      );
    const result = yield* leases.callReservation(threadId, call.value).pipe(Effect.option);
    // The session is still accepted; GOAT could not read the authority that judges the call.
    if (Option.isNone(result)) return HttpServerResponse.empty({ status: 503 });
    return HttpServerResponse.text(encodeAdmission(result.value), {
      contentType: "application/json",
      headers: { "cache-control": "no-store" },
    });
  }),
);

const primitiveReplyLayer = HttpRouter.add(
  "POST",
  COMPUTER_USE_PRIMITIVE_REPLY_ROUTE,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const threadId = yield* threadOf;
    if (threadId === undefined) return HttpServerResponse.empty({ status: 401 });
    const channel = Option.getOrUndefined(
      yield* Effect.serviceOption(ComputerUsePrimitiveChannel.ComputerUsePrimitiveChannel),
    );
    if (channel === undefined) return HttpServerResponse.empty({ status: 503 });
    const proxyChannelToken = request.headers["x-goat-proxy-channel"] ?? "";
    const attachmentGeneration = yield* channel.authenticate({ threadId, proxyChannelToken });
    if (attachmentGeneration === undefined) return HttpServerResponse.empty({ status: 401 });
    const body = yield* request.text.pipe(
      Effect.provideService(
        HttpIncomingMessage.MaxBodySize,
        ByteSize.bytes(PRIMITIVE_REPLY_BODY_BYTES),
      ),
      Effect.flatMap(decodePrimitiveReply),
      Effect.option,
    );
    if (Option.isNone(body)) return HttpServerResponse.empty({ status: 400 });
    const accepted = yield* channel.reply({
      threadId,
      attachmentGeneration,
      proxyChannelToken,
      registrationId: body.value.registrationId,
      reply: body.value,
    });
    return HttpServerResponse.empty({ status: accepted ? 204 : 409 });
  }),
);

const controlReadyLayer = HttpRouter.add(
  "POST",
  COMPUTER_USE_PRIMITIVE_CONTROL_READY_ROUTE,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const threadId = yield* threadOf;
    if (threadId === undefined) return HttpServerResponse.empty({ status: 401 });
    const channel = Option.getOrUndefined(
      yield* Effect.serviceOption(ComputerUsePrimitiveChannel.ComputerUsePrimitiveChannel),
    );
    if (channel === undefined) return HttpServerResponse.empty({ status: 503 });
    const proxyChannelToken = request.headers["x-goat-proxy-channel"] ?? "";
    const attachmentGeneration = yield* channel.authenticate({ threadId, proxyChannelToken });
    if (attachmentGeneration === undefined) return HttpServerResponse.empty({ status: 401 });
    const body = yield* request.text.pipe(Effect.flatMap(decodeControlReady), Effect.option);
    if (Option.isNone(body)) return HttpServerResponse.empty({ status: 400 });
    const accepted = yield* channel.reportControlReady({
      threadId,
      attachmentGeneration,
      proxyChannelToken,
      ...body.value,
    });
    return HttpServerResponse.empty({ status: accepted ? 204 : 409 });
  }),
);

const controlCutoffLayer = HttpRouter.add(
  "POST",
  COMPUTER_USE_PRIMITIVE_CONTROL_CUTOFF_ROUTE,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const threadId = yield* threadOf;
    if (threadId === undefined) return HttpServerResponse.empty({ status: 401 });
    const channel = Option.getOrUndefined(
      yield* Effect.serviceOption(ComputerUsePrimitiveChannel.ComputerUsePrimitiveChannel),
    );
    if (channel === undefined) return HttpServerResponse.empty({ status: 503 });
    const proxyChannelToken = request.headers["x-goat-proxy-channel"] ?? "";
    const attachmentGeneration = yield* channel.authenticate({ threadId, proxyChannelToken });
    if (attachmentGeneration === undefined) return HttpServerResponse.empty({ status: 401 });
    const body = yield* request.text.pipe(Effect.flatMap(decodeControlCutoff), Effect.option);
    if (Option.isNone(body)) return HttpServerResponse.empty({ status: 400 });
    const accepted = yield* channel.reportControlCutoff({
      threadId,
      attachmentGeneration,
      proxyChannelToken,
      ...body.value,
    });
    return HttpServerResponse.empty({ status: accepted ? 204 : 409 });
  }),
);

export const layer = Layer.mergeAll(
  streamLayer,
  reportLayer,
  callLayer,
  primitiveReplyLayer,
  controlReadyLayer,
  controlCutoffLayer,
);
