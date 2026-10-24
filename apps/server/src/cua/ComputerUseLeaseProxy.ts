/**
 * The stdio MCP server every thread's provider runs instead of the raw `cua-driver mcp`. It
 * forwards to the driver while the thread's control is live and acts on its own when it ends or
 * pauses, whether or not the agent makes another call:
 *
 * - every tools/call waits for the server to confirm the control, then checks the deadline and
 *   the apps the control allows;
 * - the deadline is a timer here, and the server pushes Stop, the kill switch and revocation
 *   over a streamed response;
 * - on an end or a lost connection it refuses new calls, sends MCP cancellation for every
 *   outstanding request, kills its `cua-driver mcp` child, answers the provider, and only
 *   then revokes the driver sessions the agent named, in the background;
 * - on a pause (a person's input or takeover) it does the same without ending, refuses calls
 *   while paused, and starts a fresh driver child when the server hands control back.
 *
 * Killing the child is what stops nested work. Against the pinned 0.37.0 driver, MCP
 * cancellation and `cua-driver revoke --session` both leave a running run_script going, while
 * closing its transport stops it after the action already dispatched (ADR-0022). The rest is
 * protocol hygiene and covers drivers that honour them. A refused call is never replayed: the
 * agent observes again.
 *
 * @module ComputerUseLeaseProxy
 */
// JSON-RPC lines pass through unchanged; only the fields the proxy acts on are read.
// @effect-diagnostics preferSchemaOverJson:off
import {
  type ComputerUseHumanInputSource,
  type ComputerUseOverlayCommand,
  type ComputerUseControlEnd,
  ComputerUseLeaseUpdate,
  type ComputerUsePauseReason,
  type ComputerUseRefusalDetail,
  computerUseRefusalReason,
} from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { goatCallText } from "@goat/contracts/agentSurface/callText";

import { approvedApps, learnApps, type ListedApp, scopeVerdict } from "./ComputerUseScope.ts";
import { admitDriverReplyScreenshots, cancelledRequestKey } from "./ComputerUseDriverReply.ts";
import { type ComputerUseCallTarget, targetOf } from "./computerUseTarget.ts";
import { inputKinds, KEEP_MS } from "./agentInputLog.ts";
import { type AgentInputReport, makeAgentInputReports } from "./agentInputReports.ts";
import {
  initialOverlayState,
  type OverlayEvent,
  overlayStep,
  replyImageSize,
} from "./ComputerUseOverlay.ts";
import type { NamedWindow, WindowPlacement } from "./x11WindowPlacement.ts";

export type LeaseEnd = ComputerUseControlEnd | "lost" | "helper_restarted" | "wrong_display";

const REQUEST = goatCallText("computer_use.request");

const DESKTOP_CAPTURE_OFF =
  "Screenshots of the whole display are off in GOAT: they would show every other app on this screen. Look at one window with get_window_state and that window's pid and window_id.";

export const LEASE_END_MESSAGES: Readonly<Record<LeaseEnd, string>> = {
  expired: `Computer use for this thread reached its time limit. A later turn gets it back while the thread is still admitted; otherwise ask again with ${REQUEST}.`,
  revoked: "A person ended computer use for this thread.",
  replaced: "A newer turn of this thread took over computer use; this connection is closed.",
  disabled: "Computer use was turned off on this host.",
  unauthorized:
    "GOAT could not confirm this thread's computer use approval, so computer use stopped.",
  stopped: "A person pressed Stop on this thread. Do not continue on the screen in this turn.",
  stopped_all: "A person stopped computer use for every thread on this host.",
  lost: "GOAT could not confirm this thread's computer use approval, so computer use stopped.",
  helper_restarted:
    "GOAT Computer Use or its driver stopped or restarted (for example after an update), so computer use for this thread ended. A call already in progress may have acted before it stopped. Do not retry; end your turn and tell the person that computer use stopped, and that Restart agent session brings it back.",
  // The driver answered about another display than the one GOAT gave it (#1358).
  wrong_display:
    "The computer use driver answered about windows that are not on the screen GOAT gave it, so nothing it says or does can be trusted. Computer use stopped for this thread.",
};

const PAUSE_STATE: Readonly<Record<ComputerUsePauseReason, string>> = {
  human_input: "A person is using this computer, so computer use is paused",
  takeover: "A person took over the screen, so computer use is paused",
  private: "A password or other secret field has focus on this computer, so computer use is paused",
};

const PAUSE_NEXT: Readonly<Record<ComputerUsePauseReason, string>> = {
  human_input:
    "Do not retry now: end your turn or wait for them to hand control back, then observe the screen again before acting.",
  takeover:
    "Do not retry now: end your turn or wait for them to hand control back, then observe the screen again before acting.",
  private: "Do not retry now; observe the screen again after the person leaves it.",
};

const pauseMessage = (reason: ComputerUsePauseReason) =>
  `${PAUSE_STATE[reason]} and your call did not run. ${PAUSE_NEXT[reason]}`;

export const PAUSE_MESSAGES: Readonly<Record<ComputerUsePauseReason, string>> = {
  human_input: pauseMessage("human_input"),
  takeover: pauseMessage("takeover"),
  private: pauseMessage("private"),
};

/**
 * Tools that only read. One the driver already had when a pause or Stop cut it off changed
 * nothing on the screen; any other tool, a script or batch included, may have acted.
 */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "check_permissions",
  "health_report",
  "get_guide",
  "list_apps",
  "list_windows",
  "get_accessibility_tree",
  "get_window_state",
  "get_screen_size",
  "get_cursor_position",
  "verify_state",
  "zoom",
  "get_session",
  "list_sessions",
  "get_agent_cursor_state",
]);

export const MAY_HAVE_ACTED =
  "This call was already with the driver when it was cut off, so it may already have acted. Never resend it unchanged, and observe the window before any later action.";
export const READ_CUT_OFF =
  "This read was cut off before it answered and changed nothing; read again before acting.";

/** Why a cut-off call ended, worded without claiming it did not run. */
export type Interruption =
  | { readonly _tag: "end"; readonly reason: LeaseEnd }
  | { readonly _tag: "pause"; readonly reason: ComputerUsePauseReason }
  | { readonly _tag: "other"; readonly detail: ComputerUseRefusalDetail; readonly message: string };

const scopeMessage = (
  reason: "app_not_approved" | "desktop_not_approved",
  app?: string,
  opaque?: boolean,
) =>
  reason === "app_not_approved"
    ? `${app ?? "This app"} is not approved for this thread, so the call did not run. Ask with ${REQUEST} and args {purpose, apps:[${JSON.stringify(app ?? "<bundle_id from list_apps>")}]}, then end your turn.`
    : opaque
      ? "This thread may control only its approved apps, and a script or batch cannot be checked against them, so it did not run. Make the calls one at a time, each with the pid and window_id of an approved app's window."
      : `This call would act on the whole desktop, and this thread may control only its approved apps, so it did not run. Target an approved app's window with its pid and window_id, or ask for the whole screen with ${REQUEST} without apps.`;

export interface LeaseProxyDriver {
  readonly send: (line: string) => Effect.Effect<void>;
  readonly lines: Stream.Stream<string>;
  readonly kill: Effect.Effect<void>;
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
  readonly controlId: string;
  readonly expiresAt: DateTime.Utc;
  /** Lines the provider writes. The proxy stops when this ends. */
  readonly input: Stream.Stream<string>;
  readonly output: (line: string) => Effect.Effect<void>;
  /** The server's view of this thread's control, newest last. Ending or failing ends it. */
  readonly leaseUpdates: Stream.Stream<ComputerUseLeaseUpdate, EU>;
  /** Starts one driver child; run again after a pause, each time in its own scope. */
  readonly startDriver: Effect.Effect<LeaseProxyDriver, ED, Scope.Scope>;
  /** Deny-only revocation of the driver sessions this connection named. */
  readonly revokeSessions: (sessions: ReadonlyArray<string>) => Effect.Effect<void>;
  /**
   * Where the windows the driver names are, against the X display GOAT gave it (#1358); absent
   * where there is no X display to check. Anything but "same" refuses.
   */
  readonly placement?: (windows: ReadonlyArray<NamedWindow>) => Effect.Effect<WindowPlacement>;
  /**
   * Tells the server the window a forwarded call names, the one a live picture shows (#1370);
   * true when the server took it. Reported only on a change, observations included.
   */
  readonly onTarget?: (target: ComputerUseCallTarget) => Effect.Effect<boolean>;
  /**
   * Tells the server of a keyboard or pointer event outside this agent's own input calls; the
   * server drops it if another agent's input covers it, else pauses every agent. True when the
   * server took it; until then each later event is offered again.
   */
  readonly onHumanInput?: (input: {
    readonly source: ComputerUseHumanInputSource;
    readonly at: number;
  }) => Effect.Effect<boolean>;
  /**
   * Tells the server one of this agent's calls that can post input started or ended, and the
   * kinds of event it can post, so another agent's helper seeing that input is not taken for a
   * person. Reports go one at a time in order; a call reaches the driver only after its start
   * report has answered, so the server knows the call before any helper can see its events.
   */
  readonly onAgentInput?: (report: AgentInputReport) => Effect.Effect<unknown>;
}

const WRONG_DISPLAY =
  "That window is not on the screen GOAT gave computer use, so the call did not run. Use a window from list_windows.";
const UNCONFIRMED_DISPLAY =
  "GOAT could not confirm that computer use is on the screen GOAT gave it, so this did not run. Call list_windows, then try again.";
/** For a call that reached the driver: its answer is withheld, but it may have acted. */
const REPLY_WITHHELD =
  "This call reached the driver, so it may already have acted, but GOAT could not confirm its answer is about the screen GOAT gave it and withheld it. Never resend it unchanged.";
const REPLY_UNCONFIRMED = `${REPLY_WITHHELD} Call list_windows and observe the window before any later action.`;

/**
 * Tools that act on no app: they run before the driver has shown it is on GOAT's screen. Every
 * other tool waits for that proof (#1358).
 */
const PROOF_FREE: ReadonlySet<string> = new Set([
  "check_permissions",
  "get_guide",
  "list_apps",
  "list_windows",
  "get_screen_size",
  "get_cursor_position",
  "start_session",
  "get_session",
  "list_sessions",
  "get_agent_cursor_state",
]);

const MAX_NAMED_NODES = 4_096;

/**
 * Every window a driver reply or request names, wherever it sits (a list, a nested target, a
 * popup). A window_id without its own pid belongs to the nearest enclosing pid. Undefined when
 * the value is too large to read whole, or names a window with no pid at all.
 */
const namedWindows = (value: unknown): ReadonlyArray<NamedWindow> | undefined => {
  const found: Array<NamedWindow> = [];
  let nodes = 0;
  let complete = true;
  const visit = (entry: unknown, owner: number | undefined, depth: number) => {
    if (typeof entry !== "object" || entry === null) return;
    if (++nodes > MAX_NAMED_NODES || depth > 16) {
      complete = false;
      return;
    }
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item, owner, depth + 1);
      return;
    }
    const record = entry as { pid?: unknown; window_id?: unknown; bounds?: unknown };
    const pid = typeof record.pid === "number" ? record.pid : owner;
    if (typeof record.window_id === "number") {
      if (pid === undefined) complete = false;
      else {
        const bounds = record.bounds as Record<string, unknown> | undefined;
        const box =
          typeof bounds?.x === "number" &&
          typeof bounds.y === "number" &&
          typeof bounds.width === "number" &&
          typeof bounds.height === "number"
            ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
            : undefined;
        found.push({ pid, windowId: record.window_id, ...(box ? { bounds: box } : {}) });
      }
    }
    for (const child of Object.values(record)) visit(child, pid, depth + 1);
  };
  visit(value, undefined, 0);
  return complete ? found : undefined;
};

type JsonRpcId = string | number;
interface Envelope {
  readonly id?: JsonRpcId | null;
  readonly method?: string;
  readonly params?: {
    readonly name?: unknown;
    readonly arguments?: { readonly session?: unknown };
  };
  readonly result?: {
    readonly structuredContent?: { readonly session?: unknown };
    readonly isError?: unknown;
  };
  readonly error?: unknown;
}

const parse = (line: string): Envelope | undefined => {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Envelope)
      : undefined;
  } catch {
    return undefined;
  }
};

const decodeUpdate = Schema.decodeUnknownOption(ComputerUseLeaseUpdate);

/** Ids of the proxy's own requests to the driver; their answers never reach the provider. */
const OWN_ID = "goat-proxy:";

const refusal = (
  id: JsonRpcId,
  method: string | undefined,
  detail: ComputerUseRefusalDetail,
  message: string,
  app?: string,
) => {
  const refused = { refused: computerUseRefusalReason(detail), detail };
  return JSON.stringify(
    method === "tools/call"
      ? {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: message }],
            structuredContent: { ...refused, ...(app === undefined ? {} : { app }) },
            isError: true,
          },
        }
      : { jsonrpc: "2.0", id, error: { code: -32000, message, data: refused } },
  );
};

interface Running {
  readonly driver: LeaseProxyDriver;
  readonly scope: Scope.Closeable;
}

const pausedDetail = (reason: ComputerUsePauseReason): ComputerUseRefusalDetail =>
  reason === "private" ? "private_mode" : "waiting_for_human";

const interruptionDetail = (cause: Interruption): ComputerUseRefusalDetail =>
  cause._tag === "end"
    ? cause.reason
    : cause._tag === "pause"
      ? pausedDetail(cause.reason)
      : cause.detail;

/** What a call that never reached the driver is told: it did not run. */
const interruptionRefusal = (cause: Interruption) =>
  cause._tag === "end"
    ? LEASE_END_MESSAGES[cause.reason]
    : cause._tag === "pause"
      ? PAUSE_MESSAGES[cause.reason]
      : cause.message;

/**
 * The answer for a call the driver already had when a pause or end cut it off. The driver may
 * have dispatched its input before its transport was killed, so this is not a refusal: an agent
 * told "did not run" resends, and a resent keystroke can submit twice.
 */
const cutOff = (id: JsonRpcId, tool: string | undefined, cause: Interruption) => {
  const read = tool !== undefined && READ_ONLY_TOOLS.has(tool);
  const sentence = read ? READ_CUT_OFF : MAY_HAVE_ACTED;
  const detail = interruptionDetail(cause);
  const text =
    cause._tag === "pause"
      ? `${PAUSE_STATE[cause.reason]}. ${sentence} ${PAUSE_NEXT[cause.reason]}`
      : cause._tag === "end"
        ? `${sentence} ${LEASE_END_MESSAGES[cause.reason]}`
        : `${cause.message} ${sentence}`;
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text }],
      structuredContent: read
        ? { code: "interrupted", detail }
        : { effect: "unverifiable", code: "interrupted", detail },
      isError: true,
    },
  });
};

/**
 * The answer for a call whose reply names windows GOAT cannot place on its screen. The driver
 * already acted on it, so only a read keeps the refusal; anything else may have landed.
 */
const offScreenAnswer = (
  id: JsonRpcId,
  method: string,
  tool: string | undefined,
  verdict: "other" | "unknown",
) =>
  tool !== undefined && READ_ONLY_TOOLS.has(tool)
    ? refusal(
        id,
        method,
        "wrong_display",
        verdict === "other" ? LEASE_END_MESSAGES.wrong_display : UNCONFIRMED_DISPLAY,
      )
    : JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text:
                verdict === "other"
                  ? `${REPLY_WITHHELD} ${LEASE_END_MESSAGES.wrong_display}`
                  : REPLY_UNCONFIRMED,
            },
          ],
          structuredContent: {
            effect: "unverifiable",
            code: "interrupted",
            detail: "wrong_display",
          },
          isError: true,
        },
      });

export const runLeaseProxy = Effect.fn("ComputerUseLeaseProxy.run")(function* <EU, ED>(
  options: LeaseProxyOptions<EU, ED>,
) {
  const scope = yield* Effect.scope;
  const confirmed = yield* Deferred.make<void>();
  const ended = yield* Deferred.make<LeaseEnd>();
  let deadline = DateTime.toEpochMillis(options.expiresAt);
  let finished: LeaseEnd | undefined;
  let paused: ComputerUsePauseReason | undefined;
  let apps: ReadonlySet<string> | undefined;
  let running: Running | undefined;
  let ownRequests = 0;
  let interruptionsSeen: number | undefined;
  const handshake: Array<string> = [];
  const outstanding = new Map<
    string,
    {
      readonly id: JsonRpcId;
      readonly method: string;
      readonly tool?: string;
      readonly unfiltered?: boolean;
    }
  >();
  /** The driver child that has shown it is on GOAT's screen (#1358); a new child proves again. */
  let proven: Running | undefined;
  /**
   * Where a reply's windows are. "proof" is a reply that shows the driver is on GOAT's screen:
   * windows it names are all there, or an unfiltered list_windows saw none (a filtered one that
   * finds nothing says nothing about the screen).
   */
  const checkReply = Effect.fnUntraced(function* (
    message: Envelope,
    tool: string | undefined,
    unfiltered: boolean,
  ) {
    if (options.placement === undefined || message.result?.isError === true) return "same";
    const content = message.result?.structuredContent;
    const windows = namedWindows(content);
    if (windows === undefined) return "unknown";
    const placement = yield* options.placement(windows);
    if (placement !== "same") return placement;
    const listed =
      tool === "list_windows" &&
      unfiltered &&
      Array.isArray((content as { windows?: unknown })?.windows);
    return windows.length > 0 || listed ? "proof" : "same";
  });
  const ownAnswers = new Map<string, Deferred.Deferred<Envelope | undefined>>();
  const listed = new Map<number, ListedApp>();
  const sessions = new Set<string>();
  // The control's window survives pauses: the server keeps it until the control ends.
  let reported: ComputerUseCallTarget | undefined;
  let overlay = initialOverlayState;
  /** When the agent's own input calls were on their way, to tell a person's input apart. */
  const agentInput = yield* makeAgentInputReports({
    send: options.onAgentInput,
    ended: Deferred.await(ended),
  });

  /** Updates what the overlay shows and waits until the helper has drawn it. */
  const drawOverlay = Effect.fn("ComputerUseLeaseProxy.overlay")(function* (event: OverlayEvent) {
    const [next, commands] = overlayStep(overlay, event);
    overlay = next;
    const sink = running?.driver.overlay;
    if (sink === undefined) return;
    for (const command of commands) yield* sink(command);
  });

  /** Why the last child was cut off, for a call that was waiting when it happened. */
  let lastInterruption: Interruption = { _tag: "end", reason: "helper_restarted" };

  /**
   * Cancels every outstanding call, kills the child, then answers each one. Every outstanding
   * call reached the driver, so a tool call is answered as cut off, never as refused.
   */
  const interrupt = Effect.fn("ComputerUseLeaseProxy.interrupt")(function* (cause: Interruption) {
    lastInterruption = cause;
    const message = interruptionRefusal(cause);
    const current = running;
    running = undefined;
    const pending = [...outstanding.values()];
    outstanding.clear();
    yield* agentInput.endAll();
    if (current !== undefined) {
      for (const request of pending)
        yield* current.driver.send(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/cancelled",
            params: { requestId: request.id, reason: message },
          }),
        );
      // The transport kill is what stops nested work, so nothing runs before it that could wait.
      yield* current.driver.kill;
      yield* Scope.close(current.scope, Exit.void);
    }
    for (const waiter of ownAnswers.values()) yield* Deferred.succeed(waiter, undefined);
    proven = undefined;
    ownAnswers.clear();
    for (const request of pending)
      yield* options.output(
        request.method === "tools/call"
          ? cutOff(request.id, request.tool, cause)
          : refusal(request.id, request.method, interruptionDetail(cause), message),
      );
  });

  const end = Effect.fn("ComputerUseLeaseProxy.end")(function* (reason: LeaseEnd) {
    if (finished !== undefined) return;
    finished = reason;
    yield* Deferred.succeed(ended, reason);
    yield* drawOverlay({ type: "end" });
    yield* interrupt({ _tag: "end", reason });
    // Best effort and deny-only; a slow or stuck revoke cannot hold anything up.
    if (sessions.size > 0)
      yield* options.revokeSessions([...sessions]).pipe(Effect.ignoreCause, Effect.forkIn(scope));
  }, Effect.uninterruptible);

  const readLines = (current: Running) =>
    current.driver.lines.pipe(
      Stream.runForEach((line) =>
        Effect.gen(function* () {
          if (finished !== undefined || running !== current) return;
          const message = parse(line);
          if (message?.id !== undefined && message.id !== null && message.method === undefined) {
            learnApps(message.result, listed);
            if (typeof message.id === "string" && message.id.startsWith(OWN_ID)) {
              const waiter = ownAnswers.get(message.id);
              ownAnswers.delete(message.id);
              if (waiter !== undefined) yield* Deferred.succeed(waiter, message);
              return;
            }
            const key = JSON.stringify(message.id);
            const request = outstanding.get(key);
            // A reply to a request the provider cancelled, or never made, is stale.
            if (request === undefined) return;
            yield* agentInput.ended(key);
            const session = message.result?.structuredContent?.session;
            if (request.method === "tools/call" && typeof session === "string")
              sessions.add(session);
            if (request.method === "tools/call") {
              const verdict = yield* checkReply(message, request.tool, request.unfiltered === true);
              // Stopped, paused or cancelled while it was checked: that already answered it.
              if (finished !== undefined || running !== current || !outstanding.has(key)) return;
              // Every answered call updates the overlay; a display refusal counts as failed. It is
              // drawn while the call is still outstanding, so a stop or pause that lands during
              // the draw answers the call itself, and the check below drops this reply. A pause
              // still hiding the overlay has not answered it yet, but will.
              const failed =
                message.error !== undefined ||
                message.result?.isError === true ||
                verdict === "other" ||
                verdict === "unknown";
              const image = failed ? undefined : replyImageSize(message.result);
              yield* drawOverlay({
                type: "reply",
                id: key,
                ...(image ? { image } : {}),
                ...(failed ? { failed: true } : {}),
              });
              if (
                finished !== undefined ||
                paused !== undefined ||
                running !== current ||
                !outstanding.has(key)
              )
                return;
              outstanding.delete(key);
              if (verdict === "other") {
                yield* options.output(
                  offScreenAnswer(request.id, request.method, request.tool, "other"),
                );
                return yield* end("wrong_display");
              }
              if (verdict === "unknown")
                return yield* options.output(
                  offScreenAnswer(request.id, request.method, request.tool, "unknown"),
                );
              if (verdict === "proof") proven = current;
            } else outstanding.delete(key);
          }
          yield* options.output(admitDriverReplyScreenshots(line));
        }),
      ),
      // A driver that exits on its own cannot be trusted with the rest of the control. A helper
      // restart also invalidates its route; either way this proxy stays ended (#1348), and the
      // agent hears why instead of an approval failure (#1233).
      Effect.andThen(
        Effect.suspend(() => (running === current ? end("helper_restarted") : Effect.void)),
      ),
    );

  const start = Effect.fn("ComputerUseLeaseProxy.startDriver")(function* () {
    const child = yield* Scope.fork(scope);
    const driver = yield* options.startDriver.pipe(Scope.provide(child));
    const current: Running = { driver, scope: child };
    running = current;
    if (driver.humanInput !== undefined && options.onHumanInput !== undefined) {
      const report = options.onHumanInput;
      // Once the server took one, this child is done: the pause that follows stops it.
      let told = false;
      // Every event goes to the server, even one this agent's own call could explain: only the
      // server sees every agent's calls, and with them when a run of cover is too long. Reports
      // are slower than events, so events wait here in order until the server has judged each:
      // merging or dropping one could drop a person's. Only events older than the server still
      // judges are dropped, since it would refuse them.
      const unsent: Array<{ readonly source: ComputerUseHumanInputSource; readonly at: number }> =
        [];
      const wake = yield* Queue.sliding<void>(1);
      yield* driver.humanInput.pipe(
        Stream.runForEach((input) =>
          Effect.suspend(() => {
            if (!unsent.some((event) => event.source === input.source && event.at === input.at))
              unsent.push({ source: input.source, at: input.at });
            return Queue.offer(wake, undefined);
          }),
        ),
        Effect.forkIn(child),
      );
      yield* Effect.gen(function* () {
        while (!told) {
          yield* Queue.take(wake);
          while (!told && unsent.length > 0) {
            if (finished !== undefined || paused !== undefined || running !== current) return;
            unsent.sort((left, right) => left.at - right.at);
            const next = unsent.shift();
            if (next === undefined) break;
            if ((yield* Clock.currentTimeMillis) - next.at >= KEEP_MS) continue;
            told = yield* report(next);
          }
        }
      }).pipe(Effect.forkIn(child));
    }
    // A new helper draws nothing yet.
    overlay = initialOverlayState;
    // A fresh child after a pause hears the provider's handshake again; its answers are dropped.
    for (const line of handshake) {
      const message = parse(line);
      yield* driver.send(
        message?.id === undefined || message.id === null
          ? line
          : JSON.stringify({ ...message, id: `${OWN_ID}init:${ownRequests++}` }),
      );
    }
    yield* readLines(current).pipe(Effect.forkIn(scope));
  });

  const pause = Effect.fn("ComputerUseLeaseProxy.pause")(function* (
    reason: ComputerUsePauseReason,
  ) {
    if (finished !== undefined) return;
    const wasPaused = paused !== undefined;
    // Recorded first: a call that was drawing while this pause stopped its driver refuses
    // with this reason.
    paused = reason;
    if (!wasPaused) {
      yield* drawOverlay({ type: "pause", reason });
      yield* interrupt({ _tag: "pause", reason });
    }
    // A proxy told it is paused before it was ever active refuses its waiting calls now.
    yield* Deferred.succeed(confirmed, undefined);
  }, Effect.uninterruptible);

  const activate = Effect.fn("ComputerUseLeaseProxy.activate")(function* (
    update: Extract<ComputerUseLeaseUpdate, { readonly state: "active" }>,
  ) {
    const expiresAt = DateTime.make(update.expiresAt);
    if (Option.isSome(expiresAt))
      deadline = Math.min(deadline, DateTime.toEpochMillis(expiresAt.value));
    const next = approvedApps(update.apps);
    // Fewer apps than before: work already running may be in one of them, so it ends now and
    // anything it still answers is dropped with the old child.
    const narrowed =
      (yield* Deferred.isDone(confirmed)) &&
      next !== undefined &&
      (apps === undefined || [...apps].some((app) => !next.has(app)));
    apps = next;
    // A pause that began and ended before this update still ends the call it overlapped.
    const count = update.interruptions?.count ?? 0;
    const missedPause =
      interruptionsSeen !== undefined && count > interruptionsSeen
        ? update.interruptions
        : undefined;
    interruptionsSeen = count;
    if (paused !== undefined) {
      paused = undefined;
      if (finished === undefined) yield* start();
    } else if (missedPause !== undefined && finished === undefined && running !== undefined) {
      yield* interrupt({ _tag: "pause", reason: missedPause.last });
      yield* start();
    } else if (narrowed && finished === undefined && running !== undefined) {
      yield* interrupt({
        _tag: "other",
        detail: "app_not_approved",
        message:
          "An app this call used is no longer approved for this thread, so it was stopped. Observe again before acting.",
      });
      yield* start();
    }
    yield* Deferred.succeed(confirmed, undefined);
  }, Effect.uninterruptible);

  yield* start();

  // The server is the authority: the first word for this control confirms it, anything else ends.
  yield* options.leaseUpdates.pipe(
    Stream.runForEach((update) =>
      update.state !== "ended" && update.controlId !== options.controlId
        ? end("lost")
        : update.state === "active"
          ? activate(update)
          : update.state === "paused"
            ? pause(update.reason)
            : end(update.reason === "unauthorized" ? "lost" : update.reason),
    ),
    Effect.catchCause(() => Effect.void),
    Effect.andThen(end("lost")),
    Effect.forkScoped,
  );

  // Held here, not in the agent's calls: expiry acts while a call is outstanding or none comes.
  yield* Effect.gen(function* () {
    for (;;) {
      const now = yield* Clock.currentTimeMillis;
      if (now >= deadline) {
        yield* end("expired");
        return;
      }
      yield* Effect.sleep(deadline - now);
    }
  }).pipe(Effect.forkScoped);

  /** Asks the driver which apps run, so a pid it has not named yet can be judged. */
  const listApps = Effect.fn("ComputerUseLeaseProxy.listApps")(function* () {
    if (running === undefined) return;
    const id = `${OWN_ID}apps:${ownRequests++}`;
    const answered = yield* Deferred.make<Envelope | undefined>();
    ownAnswers.set(id, answered);
    yield* running.driver.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "list_apps", arguments: {} },
      }),
    );
    yield* Effect.raceFirst(Deferred.await(answered), Deferred.await(ended).pipe(Effect.asVoid));
  });

  /** Asks the driver for its windows, to show it is on GOAT's screen before anything acts. */
  const proveDisplay = Effect.fn("ComputerUseLeaseProxy.proveDisplay")(function* () {
    const current = running;
    if (current === undefined || proven === current) return;
    const id = `${OWN_ID}windows:${ownRequests++}`;
    const answered = yield* Deferred.make<Envelope | undefined>();
    ownAnswers.set(id, answered);
    yield* current.driver.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "list_windows", arguments: {} },
      }),
    );
    const answer = yield* Effect.raceFirst(
      Deferred.await(answered),
      Deferred.await(ended).pipe(Effect.as(undefined)),
    );
    if (answer === undefined || finished !== undefined || running !== current) return;
    const verdict = yield* checkReply(answer, "list_windows", true);
    if (finished !== undefined || running !== current) return;
    if (verdict === "other") return yield* end("wrong_display");
    if (verdict === "proof") proven = current;
  });

  /** The refusal line for a confirmed tools/call that cannot run now; undefined forwards it. */
  const refuseCall = Effect.fn("ComputerUseLeaseProxy.refuseCall")(function* (
    id: JsonRpcId,
    message: Envelope,
  ) {
    if (finished === undefined && (yield* Clock.currentTimeMillis) >= deadline)
      yield* end("expired");
    const judge = () =>
      scopeVerdict({
        name: message.params?.name,
        args: message.params?.arguments,
        apps,
        appOf: (pid) => listed.get(pid),
      });
    let verdict = judge();
    if (verdict._tag === "resolve" && finished === undefined && paused === undefined) {
      yield* listApps();
      verdict = judge();
    }
    if (finished !== undefined)
      return refusal(id, message.method, finished, LEASE_END_MESSAGES[finished]);
    if (paused !== undefined)
      return refusal(id, message.method, pausedDetail(paused), PAUSE_MESSAGES[paused]);
    // The driver no longer lists it (cuaDriverManifest.ts); a stale tool list still gets a reason.
    if (message.params?.name === "get_desktop_state")
      return refusal(id, message.method, "desktop_capture_off", DESKTOP_CAPTURE_OFF);
    if (verdict._tag === "resolve")
      return refusal(
        id,
        message.method,
        "app_not_approved",
        scopeMessage(
          "app_not_approved",
          listed.get(verdict.pid)?.id ?? `the app with pid ${verdict.pid}`,
        ),
      );
    if (verdict._tag === "refuse")
      return refusal(
        id,
        message.method,
        verdict.reason,
        scopeMessage(verdict.reason, verdict.app, verdict.opaque),
        verdict.app,
      );
    return undefined;
  });

  const handle = Effect.fn("ComputerUseLeaseProxy.forward")(function* (line: string) {
    const message = parse(line);
    const id = message?.id;
    const isRequest = id !== undefined && id !== null && message?.method !== undefined;
    if (message?.method === "initialize" || message?.method === "notifications/initialized")
      handshake.push(line);
    if (finished !== undefined) {
      if (isRequest)
        yield* options.output(refusal(id, message?.method, finished, LEASE_END_MESSAGES[finished]));
      return;
    }
    if (isRequest && message?.method === "tools/call") {
      yield* Effect.raceFirst(Deferred.await(confirmed), Deferred.await(ended).pipe(Effect.asVoid));
      // The child this call was admitted under. A pause, takeover or narrowed approval while it
      // waits replaces the child, and the call belongs to what was cut off, never to the next one.
      const admitted = running;
      const tool = typeof message.params?.name === "string" ? message.params.name : undefined;
      const needsProof =
        options.placement !== undefined && (tool === undefined || !PROOF_FREE.has(tool));
      if (options.placement !== undefined && finished === undefined && paused === undefined) {
        // A window that is not on GOAT's screen is never acted on, whatever the driver would do.
        const targets = namedWindows(message.params?.arguments);
        if (targets === undefined)
          return yield* options.output(
            refusal(id, message.method, "wrong_display", UNCONFIRMED_DISPLAY),
          );
        if (targets.length > 0 && (yield* options.placement(targets)) !== "same")
          return yield* options.output(refusal(id, message.method, "wrong_display", WRONG_DISPLAY));
        if (needsProof) yield* proveDisplay();
      }
      // The last wait before the driver hears the call: it judges the control as it is now.
      const refused = yield* refuseCall(id, message);
      if (refused !== undefined) return yield* options.output(refused);
      if (admitted !== undefined && running !== admitted)
        return yield* options.output(
          refusal(
            id,
            message.method,
            interruptionDetail(lastInterruption),
            interruptionRefusal(lastInterruption),
          ),
        );
      if (needsProof && (running === undefined || proven !== running))
        return yield* options.output(
          refusal(
            id,
            message.method,
            "wrong_display",
            finished === "wrong_display" ? LEASE_END_MESSAGES.wrong_display : UNCONFIRMED_DISPLAY,
          ),
        );
      const session = message.params?.arguments?.session;
      if (typeof session === "string" && session.length > 0) sessions.add(session);
    }
    // Paused: there is no driver until the server hands control back.
    if (running === undefined) {
      if (isRequest)
        yield* options.output(
          refusal(
            id,
            message?.method,
            "waiting_for_human",
            PAUSE_MESSAGES[paused ?? "human_input"],
          ),
        );
      return;
    }
    // The child this line goes to. A pause, end or replacement before the send below means the
    // call never reached a driver, so it is refused; once sent, an interruption answers it as
    // cut off instead (interrupt above).
    const current = running;
    const notSent = (requestId: JsonRpcId) =>
      finished !== undefined
        ? refusal(requestId, message?.method, finished, LEASE_END_MESSAGES[finished])
        : paused !== undefined
          ? refusal(requestId, message?.method, pausedDetail(paused), PAUSE_MESSAGES[paused])
          : refusal(
              requestId,
              message?.method,
              interruptionDetail(lastInterruption),
              interruptionRefusal(lastInterruption),
            );
    const stillCurrent = () =>
      running === current && paused === undefined && finished === undefined;
    if (isRequest && message?.method === "tools/call") {
      // Before the call reaches the driver: a capture must not see the overlay (#1321).
      yield* drawOverlay({
        type: "call",
        id: JSON.stringify(id),
        name: typeof message.params?.name === "string" ? message.params.name : "",
        args: message.params?.arguments,
      });
      // A pause or end that came while drawing: refuse, whether or not it has stopped the
      // driver yet. This call never ran.
      if (!stillCurrent()) return yield* options.output(notSent(id));
      if (options.onTarget !== undefined) {
        const target = targetOf(message.params?.arguments);
        if (
          target !== undefined &&
          (target.pid !== reported?.pid || target.windowId !== reported.windowId) &&
          (yield* options.onTarget(target))
        )
          reported = target;
        // The report waits on the server; a pause or end meanwhile must not let the call reach
        // the child that replaced the one it was admitted under.
        if (!stillCurrent()) return yield* options.output(notSent(id));
      }
    }
    const cancelled = cancelledRequestKey(line);
    if (cancelled !== undefined) {
      outstanding.delete(cancelled);
      yield* agentInput.ended(cancelled);
    }
    const kinds =
      isRequest && message?.method === "tools/call"
        ? inputKinds(
            typeof message.params?.name === "string" ? message.params.name : "",
            message.params?.arguments,
          )
        : [];
    if (isRequest && kinds.length > 0) {
      yield* agentInput.started(JSON.stringify(id), kinds);
      // The start report waits on the server; a pause or end meanwhile must not let the call
      // reach the child that replaced the one it was admitted under.
      if (!stillCurrent()) {
        yield* agentInput.ended(JSON.stringify(id));
        return yield* options.output(notSent(id));
      }
    }
    if (isRequest)
      outstanding.set(JSON.stringify(id), {
        id,
        method: message!.method!,
        ...(typeof message?.params?.name === "string" ? { tool: message.params.name } : {}),
        unfiltered: Object.keys(message?.params?.arguments ?? {}).every((key) => key === "session"),
      });
    yield* current.driver.send(line);
  });

  yield* options.input.pipe(Stream.runForEach(handle));
  // The provider closed its end: nothing more to serve, and the driver child goes with it.
  if (finished === undefined) {
    finished = "lost";
    if (running !== undefined) yield* running.driver.kill;
  }
  return finished;
});

/** Parses one NDJSON chunk stream from the lease route into updates, dropping unknown lines. */
export const leaseUpdateLines = <E>(lines: Stream.Stream<string, E>) =>
  lines.pipe(
    Stream.filter((line) => line.trim().length > 0),
    Stream.map((line) => {
      const parsed = parse(line);
      return parsed === undefined ? Option.none() : decodeUpdate(parsed);
    }),
    Stream.filter(Option.isSome),
    Stream.map((update) => update.value),
  );
