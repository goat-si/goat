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
 * - on an explicit pause or takeover it does the same without ending, refuses calls
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
  ComputerUseLeaseUpdate,
  type ComputerUsePauseReason,
  type ComputerUseForegroundGrant,
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
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { proxyCallAdmission } from "./ComputerUseLeaseCallPermissions.ts";
import { requiresForeground } from "./ComputerUseCallReservations.ts";
import { reserveProxyCall } from "./ComputerUseLeaseProxyAdmission.ts";
import { makeLeaseProxyLifecycle, type Running } from "./ComputerUseLeaseProxyLifecycle.ts";
import { watchLeaseProxyDeadlines } from "./ComputerUseLeaseProxyDeadline.ts";

import { makeLeaseFences } from "./leaseUpdateFences.ts";
import {
  approvedApps,
  learnApps,
  type ListedApp,
  scopeVerdict,
  takesScreen,
} from "./ComputerUseScope.ts";
import { admitDriverReplyScreenshots, cancelledRequestKey } from "./ComputerUseDriverReply.ts";
import { type ComputerUseCallTarget, targetOf } from "./computerUseTarget.ts";
import { inputKinds } from "./agentInputLog.ts";
import { forwardHelperInput, makeAgentInputReports } from "./agentInputReports.ts";
import {
  initialOverlayState,
  type OverlayEvent,
  overlayStep,
  replyImageSize,
} from "./ComputerUseOverlay.ts";
import {
  type Envelope,
  namedWindows,
  parse,
  replyPlacement,
  sendUnlessShared,
  DISPLAY_PROOF_FREE,
} from "./ComputerUseLeaseProtocol.ts";
import {
  type Interruption,
  type LeaseEnd,
  DESKTOP_CAPTURE_OFF,
  FOREGROUND_NOT_APPROVED,
  LEASE_END_MESSAGES,
  PAUSE_MESSAGES,
  scopeMessage,
  SCREEN_SHARED,
} from "./ComputerUseLeaseMessages.ts";
import {
  type JsonRpcId,
  UNCONFIRMED_DISPLAY,
  cutOff,
  interruptionDetail,
  interruptionRefusal,
  offScreenAnswer,
  pausedDetail,
  refusal,
  reservedIdAnswer,
  unsentCallRefusal,
} from "./ComputerUseLeaseResponses.ts";
import type { LeaseProxyOptions } from "./ComputerUseLeaseProxyOptions.ts";

const WRONG_DISPLAY =
  "That window is not on the screen GOAT gave computer use, so the call did not run. Use a window from list_windows.";

const decodeUpdate = Schema.decodeUnknownOption(ComputerUseLeaseUpdate);

/** Ids of the proxy's own requests to the driver; their answers never reach the provider. */
const OWN_ID = "goat-proxy:";

export const runLeaseProxy = Effect.fn("ComputerUseLeaseProxy.run")(function* <EU, ED>(
  options: LeaseProxyOptions<EU, ED>,
) {
  const scope = yield* Effect.scope;
  const confirmed = yield* Deferred.make<void>();
  const ended = yield* Deferred.make<LeaseEnd>();
  const deadlineWake = yield* Queue.sliding<void>(1);
  let deadline = DateTime.toEpochMillis(options.expiresAt);
  let finished: LeaseEnd | undefined;
  let paused: ComputerUsePauseReason | undefined;
  let idle = false;
  let apps: ReadonlySet<string> | undefined;
  let foreground: ReadonlyArray<ComputerUseForegroundGrant> = [];
  const lifecycleLock = yield* Semaphore.make(1);
  /** Another thread holds apps on this screen; see takesScreen. */
  let shared = false;
  /**
   * What the latest active update taken says, applied or not: an older update applied after it
   * must not lift a newer update's restriction, so a call is judged by both (sharedNow).
   */
  let sharedTaken = false;
  const sharedNow = () => shared || sharedTaken;
  /** Lease updates taken but not applied yet, and what each holds back. */
  const fences = makeLeaseFences(options.controlId);
  let ownRequests = 0;
  let interruptionsSeen: number | undefined;
  let idleEpochSeen: number | undefined;
  const handshake: Array<string> = [];
  const outstanding = new Map<
    string,
    {
      readonly id: JsonRpcId;
      readonly method: string;
      readonly tool?: string;
      readonly unfiltered?: boolean;
      readonly reservationId?: string;
      readonly connectionId: string;
      readonly cancelled?: boolean;
    }
  >();
  /** The driver child that has shown it is on GOAT's screen (#1358); a new child proves again. */
  let proven: Running | undefined;
  const checkReply = (message: Envelope, tool: string | undefined, unfiltered: boolean) =>
    replyPlacement(options.placement, message, tool, unfiltered);
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
    const sink = lifecycle.current?.driver.overlay;
    if (sink === undefined) return;
    for (const command of commands) yield* sink(command);
  });

  /** Why the last child was cut off, for a call that was waiting when it happened. */
  let lastInterruption: Interruption = { _tag: "end", reason: "helper_restarted" };

  /**
   * Retains each generation's calls through native closure so cancellation can suppress its
   * final answer without releasing ownership or touching a newer child.
   */
  const interrupt = Effect.fn("ComputerUseLeaseProxy.interrupt")(function* (cause: Interruption) {
    lastInterruption = cause;
    const message = interruptionRefusal(cause);
    const { token, current } = lifecycle.interrupt();
    const pending =
      current === undefined
        ? []
        : [...outstanding].filter(([, request]) => request.connectionId === current.connectionId);
    const waiters = [...ownAnswers.values()];
    ownAnswers.clear();
    proven = undefined;
    yield* agentInput.endAll();
    if (current !== undefined) {
      for (const [, request] of pending)
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
      yield* options.reservation({
        action: "close",
        controlId: options.controlId,
        connectionId: current.connectionId,
      });
    }
    for (const waiter of waiters) yield* Deferred.succeed(waiter, undefined);
    for (const [key, request] of pending) {
      const latest = outstanding.get(key);
      if (latest?.connectionId !== request.connectionId) continue;
      outstanding.delete(key);
      if (!latest.cancelled)
        yield* options.output(
          request.method === "tools/call"
            ? cutOff(request.id, request.tool, cause)
            : refusal(request.id, request.method, interruptionDetail(cause), message),
        );
    }
    return token;
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

  const release = (request: { readonly reservationId?: string; readonly connectionId?: string }) =>
    request.reservationId === undefined || request.connectionId === undefined
      ? Effect.void
      : options
          .reservation({
            action: "release",
            controlId: options.controlId,
            connectionId: request.connectionId,
            reservationId: request.reservationId,
          })
          .pipe(Effect.asVoid);

  const readLines = (current: Running) =>
    current.driver.lines.pipe(
      Stream.runForEach((line) =>
        Effect.gen(function* () {
          if (finished !== undefined || lifecycle.current !== current) return;
          const message = parse(line);
          if (message?.id !== undefined && message.id !== null && message.method === undefined) {
            const own = typeof message.id === "string" && message.id.startsWith(OWN_ID);
            // Only the answer to a list_apps request still waiting for it says which app a pid is.
            const listing = own
              ? String(message.id).startsWith(`${OWN_ID}apps:`) &&
                ownAnswers.has(String(message.id))
              : outstanding.get(JSON.stringify(message.id))?.tool === "list_apps";
            learnApps(message.result, listed, listing);
            if (own) {
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
            if (request.cancelled) {
              yield* drawOverlay({ type: "reply", id: key, failed: true });
              yield* release(request);
              if (
                finished !== undefined ||
                paused !== undefined ||
                idle ||
                lifecycle.current !== current ||
                !outstanding.has(key)
              )
                return;
              outstanding.delete(key);
              return;
            }
            const session = message.result?.structuredContent?.session;
            if (request.method === "tools/call" && typeof session === "string")
              sessions.add(session);
            if (request.method === "tools/call") {
              const verdict = yield* checkReply(message, request.tool, request.unfiltered === true);
              // Stopped, paused or cancelled while it was checked: that already answered it.
              if (finished !== undefined || lifecycle.current !== current || !outstanding.has(key))
                return;
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
                lifecycle.current !== current ||
                !outstanding.has(key)
              )
                return;
              yield* release(request);
              const latest = outstanding.get(key);
              if (
                finished !== undefined ||
                paused !== undefined ||
                idle ||
                lifecycle.current !== current ||
                latest === undefined
              )
                return;
              outstanding.delete(key);
              if (latest.cancelled) return;
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
        Effect.suspend(() =>
          lifecycle.current === current ? end("helper_restarted") : Effect.void,
        ),
      ),
    );

  const active = () => finished === undefined && paused === undefined && !idle;
  const lifecycle = yield* makeLeaseProxyLifecycle({
    connectionId: options.connectionId,
    startDriver: options.startDriver,
    manifestStamp: options.manifestStamp,
    active,
    deadline: () => deadline,
    onStarted: Effect.fn("ComputerUseLeaseProxy.driverStarted")(
      function* (current): Effect.fn.Return<void> {
        const driver = current.driver;
        if (driver.humanInput !== undefined && options.onHumanInput !== undefined)
          yield* forwardHelperInput({
            events: driver.humanInput,
            report: options.onHumanInput,
            current: () => active() && lifecycle.current === current,
          }).pipe(Effect.scoped, Effect.forkIn(current.scope));
        if (lifecycle.current !== current) return;
        overlay = initialOverlayState;
        // A fresh child hears the provider's handshake again; its answers are dropped.
        for (const line of handshake) {
          if (lifecycle.current !== current || !active()) return;
          const message = parse(line);
          yield* driver.send(
            message?.id === undefined || message.id === null
              ? line
              : JSON.stringify({ ...message, id: `${OWN_ID}init:${ownRequests++}` }),
          );
        }
        yield* readLines(current).pipe(Effect.forkIn(scope));
      },
    ),
  });
  const start = lifecycle.start;

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
    yield* Queue.offer(deadlineWake, undefined);
  }, Effect.uninterruptible);

  const activate = Effect.fn("ComputerUseLeaseProxy.activate")(function* (
    update: Extract<ComputerUseLeaseUpdate, { readonly state: "active" }>,
  ) {
    const expiresAt = DateTime.make(update.expiresAt);
    if (Option.isSome(expiresAt))
      deadline = Math.min(deadline, DateTime.toEpochMillis(expiresAt.value));
    const next = approvedApps(update.apps);
    const nextForeground = update.foreground ?? [];
    const foregroundRemoved = foreground.some(
      (grant) => !nextForeground.some((nextGrant) => nextGrant.handoffId === grant.handoffId),
    );
    foreground = nextForeground;
    // Fewer apps than before: work already running may be in one of them, so it ends now and
    // anything it still answers is dropped with the old child.
    const narrowed =
      (yield* Deferred.isDone(confirmed)) &&
      next !== undefined &&
      (apps === undefined || [...apps].some((app) => !next.has(app)));
    apps = next;
    shared = update.shared === true;
    // A pause that began and ended before this update still ends the call it overlapped.
    const count = update.interruptions?.count ?? 0;
    const missedPause =
      interruptionsSeen !== undefined && count > interruptionsSeen
        ? update.interruptions
        : undefined;
    interruptionsSeen = count;
    const nextIdleEpoch = update.idleEpoch ?? 0;
    const missedIdle = idleEpochSeen !== undefined && nextIdleEpoch > idleEpochSeen;
    idleEpochSeen = nextIdleEpoch;
    if (paused !== undefined || idle) {
      paused = undefined;
      idle = false;
      if (finished === undefined) yield* start();
    } else if (
      missedPause !== undefined &&
      finished === undefined &&
      lifecycle.current !== undefined
    ) {
      const token = yield* interrupt({ _tag: "pause", reason: missedPause.last });
      yield* start(token);
    } else if (foregroundRemoved && finished === undefined && lifecycle.current !== undefined) {
      const token = yield* interrupt({
        _tag: "other",
        detail: "foreground_not_approved",
        message:
          "Foreground approval ended, so this work was stopped. Observe again before acting.",
      });
      yield* start(token);
    } else if (narrowed && finished === undefined && lifecycle.current !== undefined) {
      const token = yield* interrupt({
        _tag: "other",
        detail: "app_not_approved",
        message:
          "An app this call used is no longer approved for this thread, so it was stopped. Observe again before acting.",
      });
      yield* start(token);
    } else if (missedIdle && finished === undefined && lifecycle.current !== undefined) {
      const token = yield* interrupt({
        _tag: "other",
        detail: "control_idle",
        message: "This call overlapped the end of its thread's turn and was stopped.",
      });
      yield* start(token);
    }
    yield* Deferred.succeed(confirmed, undefined);
    yield* Queue.offer(deadlineWake, undefined);
  }, Effect.uninterruptible);

  yield* Effect.addFinalizer(() => end("lost"));
  yield* start();

  const apply = (
    update: ComputerUseLeaseUpdate | undefined,
    fence: ReturnType<typeof fences.take>,
  ) =>
    lifecycleLock
      .withPermits(1)(
        (update === undefined
          ? end("lost")
          : fence !== undefined && "end" in fence
            ? end(fence.end)
            : fence !== undefined && "pause" in fence
              ? pause(fence.pause)
              : update.state === "idle"
                ? Effect.sync(() => {
                    idle = true;
                  }).pipe(
                    Effect.andThen(
                      interrupt({
                        _tag: "other",
                        detail: "control_idle",
                        message:
                          "This thread's turn has ended. Computer use is idle until its next turn.",
                      }),
                    ),
                    Effect.andThen(Deferred.succeed(confirmed, undefined)),
                  )
                : activate(update as Extract<ComputerUseLeaseUpdate, { state: "active" }>)
        ).pipe(
          Effect.andThen(
            update === undefined
              ? Effect.void
              : (options.onLeaseUpdateApplied?.(update) ?? Effect.void),
          ),
        ),
      )
      .pipe(Effect.ensuring(Effect.sync(() => fences.release(fence))));
  // The server is the authority: the first word for this control confirms it, anything else
  // ends. Updates are taken here as they arrive and applied in order by one fiber, so a waiting
  // update never keeps a later one's fence from going up. The stream ending applies as lost.
  const applying = yield* Queue.unbounded<{
    readonly update: ComputerUseLeaseUpdate | undefined;
    readonly fence: ReturnType<typeof fences.take>;
  }>();
  yield* Queue.take(applying).pipe(
    Effect.flatMap(({ update, fence }) => apply(update, fence)),
    Effect.forever,
    // A failed update ends the control as lost here: this fiber is the queue's only reader.
    Effect.catchCause(() => end("lost")),
    Effect.forkScoped,
  );
  const take = (update: ComputerUseLeaseUpdate | undefined) =>
    Effect.suspend(() => {
      // Another thread's grant only denies, so it counts as soon as it is taken.
      if (update?.state === "active" && update.controlId === options.controlId)
        sharedTaken = update.shared === true;
      const fence = update === undefined ? fences.lost() : fences.take(update, apps, foreground);
      return Queue.offer(applying, { update, fence });
    });
  yield* options.leaseUpdates.pipe(
    Stream.runForEach(take),
    Effect.catchCause(() => Effect.void),
    Effect.andThen(take(undefined)),
    Effect.forkScoped,
  );

  // Held here, not in the agent's calls: expiry acts while a call is outstanding or none comes.
  yield* watchLeaseProxyDeadlines({
    wake: deadlineWake,
    controlDeadline: () => deadline,
    foregroundDeadline: () => Math.min(...foreground.map((grant) => grant.expiresAtMillis)),
    expireControl: end("expired"),
    expireForeground: Effect.fn("ComputerUseLeaseProxy.expireForeground")(function* (now) {
      foreground = foreground.filter((grant) => grant.expiresAtMillis > now);
      if (lifecycle.current === undefined) return;
      const token = yield* interrupt({
        _tag: "other",
        detail: "foreground_not_approved",
        message:
          "Foreground approval reached its time limit, so this work was stopped. Observe again before acting.",
      });
      if (active() && (yield* Clock.currentTimeMillis) < deadline) yield* start(token);
    }),
  }).pipe(
    Effect.catchCause(() => end("helper_restarted")),
    Effect.forkScoped,
  );

  /** Asks the driver which apps run, so a pid it has not named yet can be judged. */
  const listApps = Effect.fn("ComputerUseLeaseProxy.listApps")(function* () {
    if (lifecycle.current === undefined) return;
    const id = `${OWN_ID}apps:${ownRequests++}`;
    const answered = yield* Deferred.make<Envelope | undefined>();
    ownAnswers.set(id, answered);
    yield* lifecycle.current.driver.send(
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
    const current = lifecycle.current;
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
    if (answer === undefined || finished !== undefined || lifecycle.current !== current) return;
    const verdict = yield* checkReply(answer, "list_windows", true);
    if (finished !== undefined || lifecycle.current !== current) return;
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
        bundleIds: options.bundleIds,
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
    if (idle)
      return refusal(
        id,
        message.method,
        "control_idle",
        "This thread's turn has ended. Computer use is idle until its next turn.",
      );
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
        scopeMessage(verdict.reason, verdict.app, verdict.opaque, verdict.launch),
        verdict.app,
      );
    if (sharedNow() && takesScreen(message.params?.name, message.params?.arguments))
      return refusal(id, message.method, "screen_shared", SCREEN_SHARED);
    const focusNow = yield* Clock.currentTimeMillis;
    if (
      requiresForeground({
        name: typeof message.params?.name === "string" ? message.params.name : "unknown",
        args: message.params?.arguments,
      }) &&
      !foreground.some((grant) => grant.expiresAtMillis > focusNow)
    )
      return refusal(id, message.method, "foreground_not_approved", FOREGROUND_NOT_APPROVED);
    return undefined;
  });

  /**
   * The desktop rewrote the manifest for a newly approved app (#1416). A driver reads it only
   * when it starts, so an idle child is replaced before the call is judged; every check after
   * this one sees the new child.
   */
  const refreshManifest = lifecycleLock.withPermits(1)(
    Effect.gen(function* () {
      const before = lifecycle.current;
      if (
        options.manifestStamp === undefined ||
        before === undefined ||
        paused !== undefined ||
        finished !== undefined ||
        idle ||
        outstanding.size > 0
      )
        return undefined;
      const manifest = options.manifestStamp();
      if (manifest === undefined || manifest === before.manifest) return undefined;
      const token = yield* interrupt({
        _tag: "other",
        detail: "helper_restarted",
        message: LEASE_END_MESSAGES.helper_restarted,
      });
      // Stopping the old child waits; an expiry or a driver exit may have ended the control.
      if (paused !== undefined || finished !== undefined) return undefined;
      // The child this refresh started, which the call may use as its own.
      yield* start(token);
      return lifecycle.current;
    }),
  );

  const handle = Effect.fn("ComputerUseLeaseProxy.forward")(function* (line: string) {
    const message = parse(line);
    const id = message?.id;
    const isRequest = id !== undefined && id !== null && message?.method !== undefined;
    // The proxy's own ids are reserved: an answer under one would pass for the proxy's own
    // list_apps lookup and could teach it which app a pid is.
    if (isRequest && typeof id === "string" && id.startsWith(OWN_ID))
      return yield* options.output(reservedIdAnswer(id, OWN_ID));
    const cancelled = cancelledRequestKey(line);
    if (cancelled !== undefined) {
      const request = outstanding.get(cancelled);
      // The driver may ignore cancellation; ownership lasts until its reply or actual cutoff.
      if (request !== undefined) outstanding.set(cancelled, { ...request, cancelled: true });
    }
    if (isRequest && outstanding.has(JSON.stringify(id)))
      return yield* options.output(
        refusal(
          id,
          message.method,
          "invalid_target",
          "This request id still has work in progress. Use a new request id after observing its result.",
        ),
      );
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
      // Only the manifest refresh may replace it for the call.
      let admitted = lifecycle.current;
      const refreshed =
        options.manifestStamp === undefined || lifecycle.current === undefined || !active()
          ? undefined
          : yield* refreshManifest;
      if (refreshed !== undefined) admitted = refreshed;
      const tool = typeof message.params?.name === "string" ? message.params.name : undefined;
      const needsProof =
        options.placement !== undefined && (tool === undefined || !DISPLAY_PROOF_FREE.has(tool));
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
      if (admitted !== undefined && lifecycle.current !== admitted)
        return yield* options.output(
          refusal(
            id,
            message.method,
            interruptionDetail(lastInterruption),
            interruptionRefusal(lastInterruption),
          ),
        );
      if (needsProof && (lifecycle.current === undefined || proven !== lifecycle.current))
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
    if (lifecycle.current === undefined) {
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
    const current = lifecycle.current;
    // A pause or end the lease stream has taken but not applied yet, because a manifest refresh
    // holds the lock (#1416), counts as applied: the call never reaches a child.
    let selectedForeground: ComputerUseForegroundGrant | undefined;
    const notSent = (requestId: JsonRpcId) =>
      unsentCallRefusal(requestId, message?.method, {
        pending: fences.pending(),
        finished,
        paused,
        idle,
        lastInterruption,
        foregroundRevoked:
          selectedForeground !== undefined && !fences.allowsForeground(selectedForeground),
      });
    const stillCurrent = () =>
      lifecycle.current === current &&
      !idle &&
      paused === undefined &&
      finished === undefined &&
      fences.clear() &&
      (selectedForeground === undefined || fences.allowsForeground(selectedForeground));
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
    let reservationId: string | undefined;
    let permissionDeadline = Infinity;
    if (isRequest && message?.method === "tools/call") {
      const admission = yield* reserveProxyCall(options, {
        id,
        message,
        connectionId: current.connectionId,
        callId: String(ownRequests++),
        interruptions: interruptionsSeen ?? 0,
        idleEpoch: idleEpochSeen ?? 0,
        foreground,
        listed,
      });
      selectedForeground = admission.selectedForeground;
      reservationId = admission.reservationId;
      permissionDeadline = admission.deadline;
      if (!stillCurrent() || admission.refused !== undefined) {
        if (reservationId !== undefined)
          yield* release({ reservationId, connectionId: current.connectionId });
        yield* drawOverlay({ type: "reply", id: JSON.stringify(id), failed: true });
        return yield* options.output(admission.refused ?? notSent(id));
      }
    }

    const kinds =
      isRequest && message?.method === "tools/call"
        ? inputKinds(
            typeof message.params?.name === "string" ? message.params.name : "",
            message.params?.arguments,
          )
        : [];
    if (isRequest && kinds.length > 0) {
      if (options.onAgentInput !== undefined && !reservationId) {
        yield* drawOverlay({ type: "reply", id: JSON.stringify(id), failed: true });
        return yield* options.output(
          refusal(
            id,
            message?.method,
            "unauthorized",
            "The input call has no execution ticket, so it did not run.",
          ),
        );
      }
      yield* agentInput.started(JSON.stringify(id), kinds);
      // The start report waits on the server; a pause or end meanwhile must not let the call
      // reach the child that replaced the one it was admitted under.
      if (!stillCurrent()) {
        yield* agentInput.ended(JSON.stringify(id));
        if (reservationId !== undefined)
          yield* release({ reservationId, connectionId: current.connectionId });
        yield* drawOverlay({ type: "reply", id: JSON.stringify(id), failed: true });
        return yield* options.output(notSent(id));
      }
    }
    if (
      isRequest &&
      message?.method === "tools/call" &&
      kinds.length > 0 &&
      options.onAgentInput !== undefined &&
      reservationId !== undefined
    ) {
      const decision = yield* options.reservation({
        action: "validate",
        controlId: options.controlId,
        connectionId: current.connectionId,
        reservationId,
      });
      const confirmation = proxyCallAdmission(
        id,
        message,
        decision,
        listed,
        options.bundleIds,
        reservationId,
      );
      permissionDeadline = Math.min(permissionDeadline, confirmation.deadline);
      if (!stillCurrent() || confirmation.refused !== undefined) {
        yield* release({ reservationId, connectionId: current.connectionId });
        yield* agentInput.ended(JSON.stringify(id));
        yield* drawOverlay({ type: "reply", id: JSON.stringify(id), failed: true });
        return yield* options.output(confirmation.refused ?? notSent(id));
      }
    }
    // The last checks, the call's registration and the write run as one step with no scheduler
    // yield (sendUnlessShared, #1496): a pause, narrowing or another thread's grant that lands
    // first keeps the call unsent and unregistered, so it is answered as not run.
    const register = Effect.sync(() => {
      if (isRequest)
        outstanding.set(JSON.stringify(id), {
          id,
          method: message!.method!,
          ...(typeof message?.params?.name === "string" ? { tool: message.params.name } : {}),
          unfiltered: Object.keys(message?.params?.arguments ?? {}).every(
            (key) => key === "session",
          ),
          connectionId: current.connectionId,
          ...(reservationId === undefined ? {} : { reservationId }),
        });
    });
    const outcome = yield* sendUnlessShared(
      isRequest &&
        message?.method === "tools/call" &&
        takesScreen(message.params?.name, message.params?.arguments),
      sharedNow,
      stillCurrent,
      register.pipe(Effect.andThen(current.driver.send(line))),
      permissionDeadline,
    );
    if (outcome !== "sent" && id !== undefined && id !== null && isRequest) {
      const key = JSON.stringify(id);
      // It never reached the driver: its window reservation goes with it (#1462).
      if (reservationId !== undefined)
        yield* release({ reservationId, connectionId: current.connectionId });
      yield* agentInput.ended(key);
      // Drawn as acting above; it never reaches the driver, so no reply will settle it.
      yield* drawOverlay({ type: "reply", id: key, failed: true });
      return yield* options.output(
        outcome === "shared"
          ? refusal(id, message?.method, "screen_shared", SCREEN_SHARED)
          : outcome === "expired"
            ? refusal(
                id,
                message?.method,
                "expired",
                "This call’s permission expired before dispatch, so it did not run. Observe the current approval before trying again.",
              )
            : notSent(id),
      );
    }
  });

  yield* options.input.pipe(Stream.runForEach(handle));
  // The provider closed its end: nothing more to serve, and the driver child goes with it.
  if (finished === undefined) yield* end("lost");
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
