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
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import type { AgentInputReport } from "./agentInputReports.ts";
import type { JsonRpcId } from "./ComputerUseLeaseResponses.ts";
import type { ComputerUseCallTarget } from "./computerUseTarget.ts";
import type { LinuxScreenshotPolicy } from "./ComputerUseLinuxScreenshots.ts";
import type { NamedWindow, WindowPlacement } from "./x11WindowPlacement.ts";
import { parse } from "./ComputerUseLeaseProtocol.ts";

export const PRIMITIVE_ID = "goat:primitive:";

export interface ReplySink {
  readonly answer: (
    line: string,
    status?: ComputerUsePrimitiveReply["status"],
    context?: { readonly tool?: string | undefined },
  ) => Effect.Effect<unknown>;
}

/** A request the proxy sent to the driver and has not answered yet. */
export interface OutstandingCall {
  readonly id: JsonRpcId;
  readonly method: string;
  readonly tool?: string;
  readonly args?: unknown;
  readonly unfiltered?: boolean;
  readonly windowId?: number;
  readonly reservationId?: string;
  readonly connectionId: string;
  readonly cancelled?: boolean;
  readonly sink: ReplySink;
}

export const primitiveReplySink = (
  request: ComputerUsePrimitiveRequest,
  reply: ((value: ComputerUsePrimitiveReply) => Effect.Effect<unknown>) | undefined,
): ReplySink => ({
  answer: Effect.fn("ComputerUseLeaseProxyOptions.answer")(
    (line: string, status: ComputerUsePrimitiveReply["status"] = "not_started") => {
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
      return (
        reply?.({
          requestId: request.requestId,
          registrationId: request.registrationId,
          controlId: request.controlId,
          connectionGeneration: request.connectionGeneration,
          runId: request.runId,
          turnId: request.turnId,
          callId: request.callId,
          status,
          ...(result === undefined ? {} : { result }),
          ...(error === undefined ? {} : { error }),
          ...(image === undefined ? {} : { image }),
        }) ?? Effect.void
      );
    },
  ),
});

export const forwardPrimitiveRequests = <E>(
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
) =>
  requests === undefined
    ? Effect.void
    : requests.pipe(
        Stream.runForEach((request) =>
          forward(
            JSON.stringify({
              jsonrpc: "2.0",
              id: nextId(),
              method: "tools/call",
              params: { name: request.tool, arguments: request.args },
            }),
            primitiveReplySink(request, reply),
            request.connectionGeneration,
            request,
          ).pipe(Effect.ensuring(Effect.sync(() => onSettled?.(request.requestId)))),
        ),
        Effect.forkScoped,
        Effect.asVoid,
      );

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
  readonly cursorEvents?: Stream.Stream<AgentCursorLeaseUpdate>;
  readonly primitiveReply?: (reply: ComputerUsePrimitiveReply) => Effect.Effect<unknown>;
  readonly onDriverStarted?: (current: {
    readonly connectionId: string;
    readonly generation: number;
  }) => Effect.Effect<void>;
  readonly onDriverCutoff?: (current: {
    readonly connectionId: string;
    readonly generation: number;
  }) => Effect.Effect<void>;
  /** `tool` names the provider's call a driver reply answers, for the CLI's app guide. */
  readonly output: (
    line: string,
    context?: { readonly tool?: string | undefined },
  ) => Effect.Effect<void>;
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
  readonly onAgentInput?: (report: AgentInputReport) => Effect.Effect<unknown>;
}
