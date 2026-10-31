/**
 * What the computer use lease proxy (ComputerUseLeaseProxy.ts) is given: its driver child, the
 * server's word on the control, and the reports it sends back.
 *
 * @module ComputerUseLeaseProxyOptions
 */
// @effect-diagnostics preferSchemaOverJson:off -- Driver JSON-RPC responses remain opaque at this boundary.
import type {
  ComputerUseAgentCursor,
  ComputerUseCallAdmission,
  ComputerUseCallReservation,
  ComputerUseHumanInputSource,
  ComputerUseLeaseUpdate,
  ComputerUseOverlayCommand,
  ComputerUsePrimitiveReply,
  ComputerUsePrimitiveRequest,
  AgentCursorLeaseUpdate,
  AgentCursorReport,
} from "@goat/contracts";
import {
  COMPUTER_USE_PRIMITIVE_RESULT_BYTES,
  COMPUTER_USE_PRIMITIVE_RESULT_TOO_LARGE,
  DEFAULT_SCREEN_RUN_LIMITS,
} from "@goat/contracts";
import type * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import type { AgentInputReport } from "./agentInputReports.ts";
import type { BrowserClaimReport } from "./ComputerUseLeaseProxyBrowserClaims.ts";
import { SCREEN_CALL_EXPIRED } from "./ComputerUseLeaseMessages.ts";
import { type JsonRpcId, refusal, reservedIdAnswer } from "./ComputerUseLeaseResponses.ts";
import type { ComputerUseCallTarget } from "./computerUseTarget.ts";
import { type LinuxScreenshotPolicy, windowArgument } from "./ComputerUseLinuxScreenshots.ts";
import type { NamedWindow, WindowPlacement } from "./x11WindowPlacement.ts";
import {
  mergeTerminal,
  terminalErrorState,
  terminalFailure,
  terminalReplyState,
  type ComputerUseTerminalReason,
} from "./ComputerUseTerminal.ts";
import { type Envelope, parse, OWN_ID } from "./ComputerUseLeaseProtocol.ts";

export const PRIMITIVE_ID = "goat:primitive:";

/** The record of a request just written to the driver. */
export const outstandingCall = (
  message: Envelope,
  id: JsonRpcId,
  sentAt: number,
  current: { readonly connectionId: string },
  sink: ReplySink,
  reservationId: string | undefined,
  primitive: ComputerUsePrimitiveRequest | undefined,
): OutstandingCall => {
  const hops = primitive === undefined ? undefined : primitiveHops.get(primitive);
  if (hops !== undefined) hops.sentAt = sentAt;
  return {
    id,
    method: message.method ?? "",
    ...(typeof message.params?.name === "string" ? { tool: message.params.name } : {}),
    args: message.params?.arguments,
    ...windowArgument(message.params?.arguments),
    unfiltered: Object.keys(message.params?.arguments ?? {}).every((k) => k === "session"),
    connectionId: current.connectionId,
    sentAt,
    sink,
    ...(reservationId === undefined ? {} : { reservationId }),
    ...(primitive === undefined ? {} : { primitiveRequestId: primitive.requestId }),
    ...(hops === undefined ? {} : { hops }),
  };
};

/** Notes when the proxy took a screen call up, after any wait behind earlier ones. */
export const beginHops = (primitive: ComputerUsePrimitiveRequest | undefined) =>
  Effect.map(Clock.currentTimeMillis, (now) => {
    const hops = primitive === undefined ? undefined : primitiveHops.get(primitive);
    if (hops !== undefined) hops.forwardAt = now;
  });

export interface ReplyContext {
  readonly tool?: string | undefined;
  readonly request?: Envelope | undefined;
  readonly terminalState?: () => {
    readonly reason?: ComputerUseTerminalReason | undefined;
    readonly possibleCommit?: boolean | undefined;
  };
}

export interface ReplySink {
  readonly terminal?: (() =>
    | import("./ComputerUseTerminal.ts").ComputerUseTerminalReason
    | undefined) & { readonly release?: () => void };
  readonly release?: () => void;
  readonly answer: (
    line: string,
    status?: ComputerUsePrimitiveReply["status"],
    context?: ReplyContext,
  ) => Effect.Effect<unknown>;
}

/** When a screen call reached each step of the proxy, on its clock; the reply reports the gaps. */
export interface PrimitiveHops {
  readonly receivedAt: number;
  forwardAt?: number;
  sentAt?: number;
  lineAt?: number;
}

const primitiveHops = new WeakMap<ComputerUsePrimitiveRequest, PrimitiveHops>();

const hopTimes = (hops: PrimitiveHops | undefined, answeredAt: number) => {
  if (hops === undefined) return undefined;
  const between = (from: number | undefined, to: number | undefined) =>
    from === undefined || to === undefined ? undefined : { ms: Math.max(0, to - from) };
  const queue = between(hops.receivedAt, hops.forwardAt);
  const admit = between(hops.forwardAt, hops.sentAt);
  const driver = between(hops.sentAt, hops.lineAt);
  const reply = between(hops.lineAt, answeredAt);
  return {
    ...(queue === undefined ? {} : { queueMs: queue.ms }),
    ...(admit === undefined ? {} : { admitMs: admit.ms }),
    ...(driver === undefined ? {} : { driverMs: driver.ms }),
    ...(reply === undefined ? {} : { replyMs: reply.ms }),
  };
};

/** A request the proxy sent to the driver and has not answered yet. */
export interface OutstandingCall {
  readonly browserClaim?: import("./ComputerUseLeaseProxyBrowserClaims.ts").ProxyBrowserClaim;
  readonly id: JsonRpcId;
  readonly method: string;
  readonly tool?: string;
  readonly args?: unknown;
  readonly unfiltered?: boolean;
  readonly windowId?: number;
  readonly reservationId?: string;
  readonly connectionId: string;
  readonly sentAt?: number;
  /** The server's request id, for a call that came from a screen cell. */
  readonly primitiveRequestId?: string;
  /** The screen call's step times, finished when the driver's line arrives. */
  readonly hops?: PrimitiveHops;
  cancelled?: boolean;
  readonly sink: ReplySink;
}

export const primitiveReplySink = (
  request: ComputerUsePrimitiveRequest,
  reply: ((value: ComputerUsePrimitiveReply) => Effect.Effect<unknown>) | undefined,
): ReplySink => ({
  answer: Effect.fn("ComputerUseLeaseProxyOptions.answer")(function* (
    line: string,
    status: ComputerUsePrimitiveReply["status"] = "not_started",
    context?: ReplyContext,
  ) {
    const answeredAt = yield* Clock.currentTimeMillis;
    const envelope = parse(line);
    const rawResult = envelope?.result;
    const record = (value: unknown): Record<string, unknown> | undefined =>
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
    const resultObject = record(rawResult);
    const content = Array.isArray(resultObject?.content) ? resultObject.content : [];
    const imagePart = content.map(record).find((part) => part?.type === "image");
    const jsonRecord = (text: unknown) => {
      if (typeof text !== "string") return undefined;
      try {
        return record(JSON.parse(text));
      } catch {
        return undefined;
      }
    };
    // Cua Driver sends a window read with an image as that image and its state in JSON text.
    const textState =
      resultObject?.structuredContent === undefined
        ? content
            .map(record)
            .filter((part) => part?.type === "text")
            .map((part) => jsonRecord(part?.text))
            .find((value) => value !== undefined)
        : undefined;
    const state = record(resultObject?.structuredContent) ?? textState;
    const width = state?.screenshot_width;
    const height = state?.screenshot_height;
    const bytes = imagePart?.data;
    const imageSize =
      typeof bytes === "string" &&
      bytes.length <= Math.ceil(DEFAULT_SCREEN_RUN_LIMITS.imageBytes / 3) * 4 &&
      /^[A-Za-z0-9+/]*={0,2}$/.test(bytes)
        ? Buffer.from(bytes, "base64").byteLength
        : Infinity;
    const validImage =
      imagePart !== undefined &&
      (imagePart.mimeType === "image/png" || imagePart.mimeType === "image/jpeg") &&
      typeof bytes === "string" &&
      bytes.length % 4 === 0 &&
      imageSize <= DEFAULT_SCREEN_RUN_LIMITS.imageBytes &&
      Number.isSafeInteger(width) &&
      (width as number) > 0 &&
      Number.isSafeInteger(height) &&
      (height as number) > 0;
    const image = validImage
      ? {
          mimeType: imagePart.mimeType as "image/png" | "image/jpeg",
          bytes: bytes as string,
          width: width as number,
          height: height as number,
        }
      : undefined;
    const imageError = imagePart !== undefined && !validImage;
    const strippedResult =
      imagePart === undefined && textState === undefined
        ? rawResult
        : {
            ...resultObject,
            ...(textState === undefined ? {} : { structuredContent: textState }),
            content: content.filter((part) => record(part)?.type !== "image"),
          };
    const bounded = (value: unknown, maxBytes: number) => {
      if (value === undefined) return undefined;
      const encoded = JSON.stringify(value);
      const bytes = encoded === undefined ? Infinity : Buffer.byteLength(encoded);
      return encoded !== undefined && bytes <= maxBytes
        ? (JSON.parse(encoded) as ComputerUsePrimitiveReply["result"])
        : {
            code: COMPUTER_USE_PRIMITIVE_RESULT_TOO_LARGE,
            message: "Driver reply exceeded the primitive channel limit.",
            ...(Number.isFinite(bytes) ? { bytes } : {}),
            maxBytes,
            // A driver failure stays one when only its size is lost.
            ...(record(value)?.isError === true ? { isError: true } : {}),
          };
    };
    const result = imageError
      ? undefined
      : bounded(strippedResult, COMPUTER_USE_PRIMITIVE_RESULT_BYTES);
    const error = bounded(
      imageError
        ? { message: "Driver image exceeded the primitive image limit or was invalid." }
        : envelope?.error,
      64 * 1024,
    );
    const hops = hopTimes(primitiveHops.get(request), answeredAt);
    const terminal = mergeTerminal(
      mergeTerminal(terminalReplyState(rawResult, status), terminalErrorState(envelope?.error)),
      context?.terminalState?.() ?? {},
    );
    const failure = terminalFailure(
      terminal.reason,
      terminal.possibleCommit ? "click" : request.tool,
      request.args,
      terminal.possibleCommit,
    );
    return yield* (
      reply?.({
        requestId: request.requestId,
        registrationId: request.registrationId,
        controlId: request.controlId,
        connectionGeneration: request.connectionGeneration,
        runId: request.runId,
        turnId: request.turnId,
        callId: request.callId,
        status,
        ...(failure === undefined
          ? {
              ...(result === undefined ? {} : { result }),
              ...(error === undefined ? {} : { error }),
              ...(image === undefined ? {} : { image }),
            }
          : {
              result: {
                isError: true,
                structuredContent: {
                  code: failure.code,
                  ...(failure.safety === undefined
                    ? {}
                    : {
                        safety: {
                          possibleCommit: failure.safety.possibleCommit,
                          retryClass: failure.safety.retryClass,
                          writeStatus: failure.safety.writeStatus,
                          code: failure.safety.code,
                        },
                      }),
                },
                content: [{ type: "text", text: failure.nextStep }],
              },
            }),
        ...(hops === undefined || Object.keys(hops).length === 0 ? {} : { hops }),
      }) ?? Effect.void
    );
  }),
});

/** Screen calls whose line reached the driver, marked in the same step that sends it. */
export const dispatchedPrimitives = new WeakSet<ComputerUsePrimitiveRequest>();

/**
 * Runs screen calls one at a time in arrival order. One held up (a slow reservation, a held
 * chain) must not leave those behind it silent: each still unsent at its own deadline is answered
 * then as never sent, so the cell does not take it for a call the driver may be running.
 */
export const forwardPrimitiveRequests = Effect.fnUntraced(function* <E>(
  requests: Stream.Stream<ComputerUsePrimitiveRequest> | undefined,
  reply: ((value: ComputerUsePrimitiveReply) => Effect.Effect<unknown>) | undefined,
  nextId: () => string,
  forward: (
    line: string,
    sink: ReplySink,
    connectionId: string,
    request: ComputerUsePrimitiveRequest,
  ) => Effect.Effect<unknown, E>,
  onSettled?: (requestId: string) => void,
  wrap?: (sink: ReplySink, id: string, request: ComputerUsePrimitiveRequest) => ReplySink,
) {
  if (requests === undefined) return;
  const waiting = yield* Queue.unbounded<{
    readonly request: ComputerUsePrimitiveRequest;
    readonly id: string;
    readonly sink: ReplySink;
  }>();
  yield* Queue.take(waiting).pipe(
    Effect.flatMap(({ request, id, sink }) =>
      forward(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name: request.tool, arguments: request.args },
        }),
        sink,
        request.connectionGeneration,
        request,
      ).pipe(Effect.ensuring(Effect.sync(() => onSettled?.(request.requestId)))),
    ),
    Effect.forever,
    Effect.forkScoped,
  );
  yield* requests.pipe(
    Stream.runForEach((request) =>
      Effect.gen(function* () {
        const id = nextId();
        primitiveHops.set(request, { receivedAt: yield* Clock.currentTimeMillis });
        const first = primitiveReplySink(request, reply);
        let answered = false;
        const guard: ReplySink = {
          answer: (line, status, context) =>
            Effect.suspend(() => {
              if (answered) return Effect.void;
              answered = true;
              return first.answer(line, status, context);
            }),
        };
        const sink = wrap?.(guard, id, request) ?? guard;
        yield* Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) => Effect.sleep(Math.max(0, request.deadlineMillis - now))),
          Effect.andThen(
            Effect.suspend(() =>
              dispatchedPrimitives.has(request)
                ? Effect.void
                : sink.answer(refusal(id, "tools/call", "expired", SCREEN_CALL_EXPIRED)),
            ),
          ),
          Effect.forkScoped,
        );
        yield* Queue.offer(waiting, { request, id, sink });
      }),
    ),
    Effect.forkScoped,
  );
});

export interface LeaseProxyDriver {
  readonly send: (line: string) => Effect.Effect<void>;
  readonly lines: Stream.Stream<string>;
  readonly kill: Effect.Effect<void>;
  /**
   * The child's exit code once it has exited on its own, or undefined when it is unknown. Read
   * after its output ends, to tell a helper that refused its parent (77) from one that restarted.
   */
  readonly exitCode?: Effect.Effect<number | undefined>;
  /**
   * The helper's cursor overlay channel, when this child draws one (#1214). Returns once the
   * change is on screen, so a capture forwarded after a hide cannot contain the overlay.
   */
  readonly overlay?: (command: ComputerUseOverlayCommand) => Effect.Effect<void>;
  /**
   * Keyboard and pointer events the macOS helper saw, each with when it happened on this
   * process's clock, every agent's own included (#1235). Absent where the child reports none.
   */
  readonly personStop?: Stream.Stream<void>;
  readonly humanInput?: Stream.Stream<{
    readonly source: ComputerUseHumanInputSource;
    readonly at: number;
  }>;
}

export interface LeaseProxyOptions<EU, ED> {
  readonly connectionId: string;
  readonly reservation: (
    call: ComputerUseCallReservation,
  ) => Effect.Effect<ComputerUseCallAdmission>;
  readonly controlId: string;
  readonly expiresAt: DateTime.Utc;
  /** This host's apps have bundle ids (macOS); see scopeVerdict. */
  readonly bundleIds: boolean;
  /** Lines the provider writes. The proxy stops when this ends. */
  readonly input: Stream.Stream<string>;
  /** Server-origin calls share the driver's admission path but answer on a separate channel. */
  readonly primitiveRequests?: Stream.Stream<ComputerUsePrimitiveRequest>;
  readonly primitiveCancelled?: (requestId: string) => boolean;
  readonly onPrimitiveSettled?: (requestId: string) => void;
  /** Delivers each screen call the server cancelled; returns the unsubscribe. */
  readonly subscribePrimitiveCancels?: (listener: (requestId: string) => void) => () => void;
  readonly cursorEvents?: Stream.Stream<AgentCursorLeaseUpdate>;
  readonly primitiveReply?: (reply: ComputerUsePrimitiveReply) => Effect.Effect<unknown>;
  readonly onDriverStarted?: (current: {
    readonly connectionId: string;
    readonly generation: number;
  }) => Effect.Effect<void>;
  readonly onDriverCutoff?: (current: {
    readonly connectionId: string;
    readonly generation: number;
    readonly terminal?: "stopped_by_person" | "screen_locked";
  }) => Effect.Effect<void>;
  /** `tool` names the provider's call a driver reply answers, for the CLI's app guide. */
  readonly output: (line: string, context?: ReplyContext) => Effect.Effect<void>;
  /** The server's view of this thread's control, newest last. Ending or failing ends it. */
  readonly leaseUpdates: Stream.Stream<ComputerUseLeaseUpdate, EU>;
  /** Starts one driver child; run again after a pause, each time in its own scope. */
  readonly startDriver: Effect.Effect<LeaseProxyDriver, ED, Scope.Scope>;
  /**
   * Starts a child that only answers the MCP handshake while the control is paused (#1604): it
   * gets no overlay channel or input feed. Defaults to startDriver.
   */
  readonly startHandshakeDriver?: Effect.Effect<LeaseProxyDriver, ED, Scope.Scope>;
  /**
   * Identifies the driver's capability manifest file as it is now (#1416), where the driver
   * reads one from a known path; absent elsewhere. A change starts a fresh driver child. It is
   * synchronous on purpose: with no wait between reading it and acting on it, no pause, end or
   * replacement can land in between.
   */
  readonly manifestStamp?: () => string | undefined;
  /** Runs once a lease update has been applied, under the lifecycle lock; for tests. */
  readonly onLeaseUpdateApplied?: (update: ComputerUseLeaseUpdate) => Effect.Effect<void>;
  /** Installs the same synchronous receipt hook used by the lease stream reader. */
  readonly onLeaseUpdateReceiver?: (
    receive: (update: ComputerUseLeaseUpdate | undefined) => void,
  ) => void;
  /** A cancelled request settled without an output line; its id can be reused now. */
  readonly onCancelledRequestSettled?: (key: string) => void;
  /**
   * True while the lease stream reconnects: no Stop or pause can arrive, so nothing but a
   * transport-safe read is sent. Checked again at the last step before each write to the driver.
   */
  readonly transportHeld?: () => boolean;
  /** Installs the hook that cuts off calls the driver has when the lease stream drops. */
  readonly onTransportDropReceiver?: (drop: () => void) => void;
  /** The first driver generation; a control started again continues past its earlier drivers. */
  readonly firstGeneration?: number;
  /** Deny-only revocation of the driver sessions this connection named. */
  readonly revokeSessions: (sessions: ReadonlyArray<string>) => Effect.Effect<void>;
  /**
   * Where the windows the driver names are, against the X display GOAT gave it (#1358); absent
   * where there is no X display to check. Anything but "same" refuses.
   */
  readonly placement?: (windows: ReadonlyArray<NamedWindow>) => Effect.Effect<WindowPlacement>;
  /** What the driver's lines may show the agent, and the calls refused for it (Linux, #1677). */
  readonly screenshots?: LinuxScreenshotPolicy;
  /**
   * Tells the server the window a forwarded call names, the one a live picture shows (#1370);
   * true when the server took it. Reported only on a change, observations included.
   */
  readonly onTarget?: (target: ComputerUseCallTarget) => Effect.Effect<boolean>;
  readonly onBrowserClaimReport?: (report: BrowserClaimReport) => void;
  /** Tells the server where the overlay draws the agent's cursor, or null when it draws none. */
  readonly onCursor?: (cursor: ComputerUseAgentCursor | null) => Effect.Effect<boolean>;
  /** The macOS helper draws the agent cursor, so the proxy answers the cursor tools. */
  readonly answersCursorTools?: boolean;
  /** The executable a pid runs, where list_apps gives none (Linux reads /proc); see learnApps. */
  readonly executableOf?: (pid: number) => string | undefined;
  /** On macOS, the app macOS asks for Automation consent: the helper, or GOAT in development. */
  readonly automationHolder?: "helper" | "app";
  readonly onCursorReport?: (report: AgentCursorReport) => Effect.Effect<boolean>;
  /**
   * Tells the server of keyboard and pointer events the helper saw, every one waiting since the
   * last report, in time order; the server drops each event another agent's input covers, and
   * pauses every agent at the first it does not. True when the server took one; until then the
   * events after them are offered in the next report.
   */
  readonly onHumanInput?: (
    events: ReadonlyArray<{
      readonly source: ComputerUseHumanInputSource;
      readonly at: number;
    }>,
  ) => Effect.Effect<boolean>;
  /**
   * Tells the server one of this agent's calls that can post input started or ended, and the
   * kinds of event it can post, so another agent's helper seeing that input is not taken for a
   * person. Reports go one at a time in order; a call reaches the driver only after its start
   * report has answered, so the server knows the call before any helper can see its events.
   */
  readonly onPersonStop?: () => Effect.Effect<boolean>;
  readonly onScreenLocked?: () => Effect.Effect<unknown>;
  readonly onAgentInput?: (report: AgentInputReport) => Effect.Effect<unknown>;
}

export const reservedProviderRequest = (
  id: JsonRpcId | null | undefined,
  method: string | undefined,
  expectedConnection: string | undefined,
) => {
  if (expectedConnection !== undefined || method === undefined || typeof id !== "string")
    return undefined;
  const prefix = id.startsWith(OWN_ID)
    ? OWN_ID
    : id.startsWith(PRIMITIVE_ID)
      ? PRIMITIVE_ID
      : undefined;
  return prefix === undefined ? undefined : reservedIdAnswer(id, prefix);
};
