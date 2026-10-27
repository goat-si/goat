/**
 * The stdio MCP server every thread's provider runs instead of the raw `cua-driver mcp`. It
 * forwards only while the control is live. Lease updates cut off pending calls even when the
 * agent sends nothing: Stop, pause, expiry and lost connection kill the child transport and
 * settle outstanding requests. Resume starts a fresh child. Driver transport closure stops
 * nested work that MCP cancellation alone does not stop (ADR-0022). Calls are never replayed.
 *
 * @module ComputerUseLeaseProxy
 */
// JSON-RPC lines pass through unchanged; only the fields the proxy acts on are read.
// @effect-diagnostics preferSchemaOverJson:off
import {
  type ComputerUseLeaseUpdate,
  type ComputerUsePauseReason,
  type ComputerUseForegroundGrant,
  type ComputerUsePrimitiveRequest,
} from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { proxyCallAdmission } from "./ComputerUseLeaseCallPermissions.ts";
import { makeTokenFirst } from "./ComputerUseTokenFirst.ts";
import { typeAutomationRefusal } from "./ComputerUseAutomationRefusal.ts";
import { releaseProxyCall, reserveProxyCall } from "./ComputerUseLeaseProxyAdmission.ts";
import { makeLeaseProxyLifecycle, type Running } from "./ComputerUseLeaseProxyLifecycle.ts";
import { makeLeaseProxyHandshake } from "./ComputerUseLeaseProxyHandshake.ts";
import { watchLeaseProxyDeadlines } from "./ComputerUseLeaseProxyDeadline.ts";
import { makeLeaseFences } from "./leaseUpdateFences.ts";
import { makeProxyChecks } from "./ComputerUseLeaseProxyChecks.ts";
import { forwardProxyCursors } from "./ComputerUseLeaseProxyCursors.ts";
import { captureStalled, driverExitReason } from "./ComputerUseDriverOutcome.ts";
import { approvedApps, learnApps, type ListedApp, takesScreen } from "./ComputerUseScope.ts";
import { admitDriverReplyScreenshots, cancelledRequestKey } from "./ComputerUseDriverReply.ts";
import { type ComputerUseCallTarget, targetOf } from "./computerUseTarget.ts";
import { inputKinds } from "./agentInputLog.ts";
import { forwardHelperInput, makeAgentInputReports } from "./agentInputReports.ts";
import { makeOverlayDrawer } from "./agentCursorReports.ts";
import { answeredByHelperCursor, answerHelperCursorCall } from "./ComputerUseCursorTools.ts";
import { resolveKeyCall } from "./ComputerUseKeyNames.ts";
import { makeInputVerifier } from "./ComputerUseInputVerify.ts";
import { overlayCallCaptures, replyImageSize } from "./ComputerUseOverlay.ts";
import { confirmCaptureHide } from "./ComputerUseCaptureHide.ts";
import { refuseCaptureFileArguments } from "./ComputerUseCaptureFiles.ts";
import {
  type Envelope,
  decodeProviderIngress,
  namedWindows,
  OWN_ID,
  parse,
  replyPlacement,
  sendUnlessShared,
  DISPLAY_PROOF_FREE,
} from "./ComputerUseLeaseProtocol.ts";
import {
  type Interruption,
  type LeaseEnd,
  LEASE_END_MESSAGES,
  PAUSE_MESSAGES,
  SCREEN_SHARED,
  WRONG_DISPLAY,
} from "./ComputerUseLeaseMessages.ts";
import {
  type JsonRpcId,
  UNCONFIRMED_DISPLAY,
  cutOff,
  interruptionDetail,
  interruptionRefusal,
  offScreenAnswer,
  refusal,
  reservedIdAnswer,
  unsentCallRefusal,
} from "./ComputerUseLeaseResponses.ts";
import {
  PRIMITIVE_ID,
  forwardPrimitiveRequests,
  type OutstandingCall,
  type ReplySink,
  type LeaseProxyOptions,
} from "./ComputerUseLeaseProxyOptions.ts";
import { windowArgument } from "./ComputerUseLinuxScreenshots.ts";
import { staleGeneration } from "./ComputerUseLeaseProxyPrimitive.ts";

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
  let shared = false;
  // An older applied update cannot lift the latest receipt's restriction (sharedNow).
  let sharedTaken = false;
  const sharedNow = () => shared || sharedTaken;
  const fences = makeLeaseFences(options.controlId);
  let ownRequests = 0;
  let interruptionsSeen: number | undefined;
  let idleEpochSeen: number | undefined;
  const handshake: Array<string> = [];
  const tokenFirst = makeTokenFirst();
  const outstanding = new Map<string, OutstandingCall>();
  /** The driver child that has shown it is on GOAT's screen (#1358); a new child proves again. */
  let proven: Running | undefined;
  /** A child whose screen capture is stuck; the next call starts a fresh one first. */
  let stalled: Running | undefined;
  const checkReply = (message: Envelope, tool: string | undefined, unfiltered: boolean) =>
    replyPlacement(options.placement, message, tool, unfiltered);
  const ownAnswers = new Map<string, Deferred.Deferred<Envelope | undefined>>();
  const verifier = makeInputVerifier({
    enabled: options.verifyInputByTreeDiff === true,
    ownAnswers,
    ended: Deferred.await(ended),
    nextId: () => `${OWN_ID}verify:${ownRequests++}`,
    scope,
    live: (child) => lifecycle.current === child && active(),
  });
  const handshakeAnswers = makeLeaseProxyHandshake({
    startDriver: options.startHandshakeDriver ?? options.startDriver,
    handshake,
    ownId: (kind) => OWN_ID + kind + ":" + ownRequests++,
    // Remembered answers are the driver's too (#1677).
    output: (line) => options.output(options.screenshots?.scrub(line) ?? line),
    ownAnswers,
    ended,
    endAnswer: (id, method, reason) => refusal(id, method, reason, LEASE_END_MESSAGES[reason]),
    onCancelledRequestSettled: (key) => options.onCancelledRequestSettled?.(key),
  });
  const listed = new Map<number, ListedApp>();
  const sessions = new Set<string>();
  // The control's window survives pauses: the server keeps it until the control ends.
  let reported: ComputerUseCallTarget | undefined;
  /** When the agent's own input calls were on their way, to tell a person's input apart. */
  const agentInput = yield* makeAgentInputReports({
    send: options.onAgentInput,
    ended: Deferred.await(ended),
  });
  const overlay = yield* makeOverlayDrawer(
    options.onCursor,
    () => lifecycle.current?.driver.overlay,
    options.onCursorReport,
  );
  const drawOverlay = overlay.draw;
  yield* forwardProxyCursors({
    events: options.cursorEvents,
    controlId: options.controlId,
    connectionId: () => lifecycle.current?.connectionId,
    active: () => finished === undefined && paused === undefined && !idle,
    draw: drawOverlay,
  });
  const providerSink: ReplySink = {
    answer: (line, _status, context) => options.output(line, context),
  };
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
    if (current !== undefined && options.onDriverCutoff !== undefined)
      yield* options.onDriverCutoff({
        connectionId: current.connectionId,
        generation: current.generation,
      });
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
      if (latest.cancelled) {
        options.onCancelledRequestSettled?.(key);
        continue;
      }
      const refuse = request.sink.answer(
        request.method === "tools/call"
          ? cutOff(request.id, request.tool, cause)
          : refusal(request.id, request.method, interruptionDetail(cause), message),
        request.sink === providerSink ? undefined : "unknown_outcome",
      );
      // A handshake the pause cut off is still answered (#1604); only an end refuses it.
      if (cause._tag !== "end" && handshakeAnswers.covers(request.method))
        yield* handshakeAnswers
          .answer(request.id, request.method, undefined, refuse)
          .pipe(Effect.forkIn(scope));
      else yield* refuse;
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

  // completed: the driver answered it, so its connection's earlier calls ended too (D17).
  const release = (
    request: { readonly reservationId?: string; readonly connectionId?: string },
    completed?: true,
  ) => releaseProxyCall(options, request, completed);

  // The buffer reads the driver apart from the replies' checks, so a driver that exits while a
  // reply waits on GOAT's capture is seen at once and that reply dropped (#1677).
  const readLines = (current: Running, exited: Deferred.Deferred<void>) =>
    current.driver.lines.pipe(
      Stream.onEnd(Deferred.succeed(exited, undefined)),
      Stream.buffer({ capacity: "unbounded" }),
      Stream.runForEach((line) =>
        Effect.gen(function* () {
          if (finished !== undefined || lifecycle.current !== current) return;
          const message = parse(line);
          let delivered = line;
          let tool: string | undefined;
          let sink = providerSink;
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
            // Stopped, ended, or answered by a pause or cancellation meanwhile.
            const gone = () =>
              finished !== undefined || lifecycle.current !== current || !outstanding.has(key);
            sink = request.sink;
            // The marked line is the driver's reply from here on, screenshot rule included.
            if (request.method === "tools/call") {
              tool = request.tool;
              if (captureStalled(line)) stalled = current;
              const marked = tokenFirst.reply(request, message, line);
              line = typeAutomationRefusal(marked, options.automationHolder, request.args, listed);
              delivered = line;
            }
            yield* agentInput.ended(key);
            if (request.cancelled) {
              yield* drawOverlay({ type: "reply", id: key, failed: true });
              yield* release(request, true);
              if (gone() || paused !== undefined || idle) return;
              outstanding.delete(key);
              options.onCancelledRequestSettled?.(key);
              return;
            }
            const session = message.result?.structuredContent?.session;
            if (request.method === "tools/call" && typeof session === "string")
              sessions.add(session);
            if (request.method === "tools/call") {
              const verdict = yield* checkReply(message, request.tool, request.unfiltered === true);
              // Stopped, paused or cancelled while it was checked: that already answered it.
              if (gone()) return;
              // Before the checks below, so a pause during GOAT's own capture drops it (#1677).
              if (options.screenshots && verdict !== "other" && verdict !== "unknown") {
                const admitted = yield* Effect.raceFirst(
                  options.screenshots.admit({ ...request, line }),
                  Effect.as(Deferred.await(exited), undefined),
                );
                if (admitted === undefined) return;
                delivered = admitted;
              }
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
              if (gone() || paused !== undefined) return;
              yield* release(request, true);
              const latest = outstanding.get(key);
              if (gone() || paused !== undefined || idle || latest === undefined) return;
              outstanding.delete(key);
              if (latest.cancelled) return options.onCancelledRequestSettled?.(key);
              if (verdict === "other") {
                yield* request.sink.answer(
                  offScreenAnswer(request.id, request.method, request.tool, "other"),
                  "settled",
                );
                return yield* end("wrong_display");
              }
              if (verdict === "unknown")
                return yield* request.sink.answer(
                  offScreenAnswer(request.id, request.method, request.tool, "unknown"),
                  "settled",
                );
              if (verdict === "proof") proven = current;
              verifier.answered(request.tool, request.args, message.result?.isError === true);
            } else {
              handshakeAnswers.remember(request.method, message);
              outstanding.delete(key);
            }
          }
          if (delivered === line) delivered = options.screenshots?.scrub(line) ?? line;
          yield* sink.answer(admitDriverReplyScreenshots(delivered), "settled", { tool });
        }),
      ),
      // A driver that exits on its own cannot be trusted with the rest of the control. A helper
      // restart also invalidates its route; either way this proxy stays ended (#1348), and the
      // agent hears why instead of an approval failure (#1233).
      Effect.andThen(
        Effect.suspend(() =>
          lifecycle.current === current
            ? driverExitReason(current.driver).pipe(Effect.flatMap(end))
            : Effect.void,
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
        overlay.reset();
        verifier.clear();
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
        yield* readLines(current, yield* Deferred.make<void>()).pipe(Effect.forkIn(scope));
        yield* handshakeAnswers.recheck(current.driver.send).pipe(Effect.forkIn(current.scope));
        if (options.onDriverStarted !== undefined)
          yield* options.onDriverStarted({
            connectionId: current.connectionId,
            generation: current.generation,
          });
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
  // Receipt fences apply before the lifecycle lock is available.
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
  const receive = (update: ComputerUseLeaseUpdate | undefined) => {
    if (
      update?.state === "primitive-request" ||
      update?.state === "primitive-cancel" ||
      update?.state === "cursor-state"
    )
      return;
    // Another thread's grant only denies, so it counts as soon as it is taken.
    if (update?.state === "active" && update.controlId === options.controlId)
      sharedTaken = update.shared === true;
    const fence = update === undefined ? fences.lost() : fences.take(update, apps, foreground);
    Queue.offerUnsafe(applying, { update, fence });
  };
  options.onLeaseUpdateReceiver?.(receive);
  const take = (update: ComputerUseLeaseUpdate | undefined) => Effect.sync(() => receive(update));
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
    Effect.catchCause(() => end("lost")),
    Effect.forkScoped,
  );
  const { proveDisplay, refuseCall } = makeProxyChecks({
    current: () => lifecycle.current,
    ownAnswers,
    ended,
    nextId: (kind) => `${OWN_ID}${kind}:${ownRequests++}`,
    proof: {
      proven: () => proven,
      setProven: (current) => {
        proven = current;
      },
      finished: () => finished,
      ...(options.placement === undefined ? {} : { placement: options.placement }),
      end,
    },
    refusal: (id, message, listApps) => ({
      id,
      message,
      finished: () => finished,
      paused: () => paused,
      idle: () => idle,
      apps: () => apps,
      listed,
      bundleIds: options.bundleIds,
      shared: sharedNow,
      toFile: () => refuseCaptureFileArguments(message.params?.arguments),
      tokenFirstRefuses: () => tokenFirst.refuses(message.params?.name, message.params?.arguments),
      foreground: () => foreground,
      listApps,
      automationTargets: options.automationHolder !== undefined,
    }),
    deadline: () => deadline,
    expire: end("expired"),
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
      const stale = manifest !== undefined && manifest !== before.manifest;
      if (!stale && stalled !== before) return undefined;
      const token = yield* interrupt({
        _tag: "other",
        detail: "helper_restarted",
        message: LEASE_END_MESSAGES.helper_restarted,
      });
      // Stopping the old child waits; an expiry or a driver exit may have ended the control.
      if (paused !== undefined || finished !== undefined) return undefined;
      yield* start(token);
      return lifecycle.current;
    }),
  );
  const forward = Effect.fn("ComputerUseLeaseProxy.forward")(function* (
    incoming: string,
    sink: ReplySink,
    expectedConnection?: string,
    primitive?: ComputerUsePrimitiveRequest,
  ) {
    // Key names are resolved first: a key no driver can press is refused before anything else.
    const keyCall = resolveKeyCall(incoming);
    if ("answer" in keyCall) return yield* sink.answer(keyCall.answer);
    const line = keyCall.line;
    const decoded = decodeProviderIngress(line);
    if (decoded.kind === "invalid") return yield* sink.answer(decoded.response);
    const message = decoded.message;
    const primitiveCurrent = () =>
      primitive === undefined || options.primitiveCancelled?.(primitive.requestId) !== true;
    const primitiveDeadline = primitive?.deadlineMillis ?? Infinity;
    const primitiveAllowed = Clock.currentTimeMillis.pipe(
      Effect.map((now) => primitiveCurrent() && now < primitiveDeadline),
    );
    if (expectedConnection !== undefined && lifecycle.current?.connectionId !== expectedConnection)
      return yield* sink.answer(staleGeneration(message.id ?? "", "tools/call"), "not_started");
    const id = message.id;
    const isRequest = id !== undefined && id !== null && message?.method !== undefined;
    // The proxy's own ids are reserved: an answer under one would pass for the proxy's own
    // list_apps lookup and could teach it which app a pid is.
    if (
      isRequest &&
      expectedConnection === undefined &&
      typeof id === "string" &&
      (id.startsWith(OWN_ID) || id.startsWith(PRIMITIVE_ID))
    )
      return yield* sink.answer(
        reservedIdAnswer(id, id.startsWith(OWN_ID) ? OWN_ID : PRIMITIVE_ID),
      );
    const cancelled = cancelledRequestKey(line);
    if (cancelled !== undefined) {
      handshakeAnswers.cancel(cancelled);
      const request = outstanding.get(cancelled);
      // The driver may ignore cancellation; ownership lasts until its reply or actual cutoff.
      if (request !== undefined) outstanding.set(cancelled, { ...request, cancelled: true });
    }
    const key = isRequest ? JSON.stringify(id) : "";
    if (isRequest && (outstanding.has(key) || handshakeAnswers.pending(key)))
      return yield* sink.answer(
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
        yield* sink.answer(refusal(id, message?.method, finished, LEASE_END_MESSAGES[finished]));
      return;
    }
    if (isRequest && message?.method === "tools/call") {
      yield* Effect.raceFirst(Deferred.await(confirmed), Deferred.await(ended).pipe(Effect.asVoid));
      if (!primitiveCurrent() || (yield* Clock.currentTimeMillis) >= primitiveDeadline)
        return yield* sink.answer(
          refusal(id, message.method, "expired", "This screen call ended before dispatch."),
        );
      if (
        expectedConnection !== undefined &&
        lifecycle.current?.connectionId !== expectedConnection
      )
        return yield* sink.answer(staleGeneration(id, message.method), "not_started");
      // The child this call was admitted under. A pause, takeover or narrowed approval while it
      // waits replaces the child, and the call belongs to what was cut off, never to the next one.
      // Only the manifest refresh may replace it for the call.
      let admitted = lifecycle.current;
      const refreshed =
        options.manifestStamp === undefined || lifecycle.current === undefined || !active()
          ? undefined
          : yield* refreshManifest;
      if (refreshed !== undefined) admitted = refreshed;
      if (
        expectedConnection !== undefined &&
        lifecycle.current?.connectionId !== expectedConnection
      )
        return yield* sink.answer(staleGeneration(id, message.method), "not_started");
      const tool = typeof message.params?.name === "string" ? message.params.name : undefined;
      const needsProof =
        options.placement !== undefined && (tool === undefined || !DISPLAY_PROOF_FREE.has(tool));
      if (options.placement !== undefined && finished === undefined && paused === undefined) {
        const targets = namedWindows(message.params?.arguments);
        if (targets === undefined)
          return yield* sink.answer(
            refusal(id, message.method, "wrong_display", UNCONFIRMED_DISPLAY),
          );
        if (targets.length > 0 && (yield* options.placement(targets)) !== "same")
          return yield* sink.answer(refusal(id, message.method, "wrong_display", WRONG_DISPLAY));
        if (needsProof) yield* proveDisplay(primitiveAllowed);
      }
      const refused = yield* refuseCall(id, message, primitiveAllowed);
      if (refused !== undefined) return yield* sink.answer(refused);
      if (admitted !== undefined && lifecycle.current !== admitted)
        return yield* sink.answer(
          refusal(
            id,
            message.method,
            interruptionDetail(lastInterruption),
            interruptionRefusal(lastInterruption),
          ),
        );
      if (needsProof && (lifecycle.current === undefined || proven !== lifecycle.current))
        return yield* sink.answer(
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
    // Paused: no driver until control comes back. The handshake is still answered (#1604), in
    // the background so a cancel or Stop on the input reaches it; tool calls hear the pause.
    if (lifecycle.current === undefined) {
      if (!isRequest) return;
      const refuse = sink.answer(
        refusal(id, message.method, "waiting_for_human", PAUSE_MESSAGES[paused ?? "human_input"]),
      );
      return yield* handshakeAnswers.covers(message.method)
        ? handshakeAnswers.answer(id, message.method, line, refuse).pipe(Effect.forkIn(scope))
        : refuse;
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
      primitiveCurrent() &&
      (expectedConnection === undefined || current.connectionId === expectedConnection) &&
      !idle &&
      paused === undefined &&
      finished === undefined &&
      fences.clear() &&
      (selectedForeground === undefined || fences.allowsForeground(selectedForeground));
    const name = message?.method === "tools/call" ? message.params?.name : undefined;
    const args = message?.params?.arguments;
    if (isRequest && options.answersCursorTools && answeredByHelperCursor(name, args)) {
      if (!stillCurrent()) return yield* sink.answer(notSent(id));
      const line = yield* answerHelperCursorCall(id, String(name), args, overlay, drawOverlay);
      return yield* sink.answer(line, "settled", { tool: String(name) });
    }
    if (isRequest && message?.method === "tools/call") {
      // Before the call reaches the driver: a capture must not see the overlay (#1321).
      yield* drawOverlay({
        type: "call",
        id: JSON.stringify(id),
        name: typeof message.params?.name === "string" ? message.params.name : "",
        args: message.params?.arguments,
        codeMode: typeof id === "string" && id.startsWith(PRIMITIVE_ID),
      });
      if (!stillCurrent()) return yield* sink.answer(notSent(id));
      const overlayChannel = current.driver.overlay;
      if (
        overlayCallCaptures(
          typeof message.params?.name === "string" ? message.params.name : "",
          message.params?.arguments,
        ) &&
        overlayChannel !== undefined &&
        "captureHideConfirmed" in overlayChannel &&
        typeof overlayChannel.captureHideConfirmed === "function" &&
        !(yield* confirmCaptureHide(
          overlayChannel,
          overlayChannel.captureHideConfirmed as () => boolean,
        ))
      ) {
        yield* drawOverlay({ type: "reply", id: JSON.stringify(id), failed: true });
        return yield* sink.answer(
          refusal(
            id,
            message.method,
            "capture_hide_unconfirmed",
            "GOAT could not confirm that its cursor overlay was hidden. This capture did not run; wait for the helper and observe again.",
          ),
        );
      }
      if (options.onTarget !== undefined) {
        const target = targetOf(message.params?.arguments);
        if (
          target !== undefined &&
          (target.pid !== reported?.pid || target.windowId !== reported.windowId) &&
          (yield* options.onTarget(target))
        )
          reported = target;
        if (!stillCurrent()) return yield* sink.answer(notSent(id));
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
        return yield* sink.answer(admission.refused ?? notSent(id));
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
        return yield* sink.answer(
          refusal(
            id,
            message?.method,
            "unauthorized",
            "The input call has no execution ticket, so it did not run.",
          ),
        );
      }
      yield* agentInput.started(JSON.stringify(id), kinds);
      if (!stillCurrent()) {
        yield* agentInput.ended(JSON.stringify(id));
        if (reservationId !== undefined)
          yield* release({ reservationId, connectionId: current.connectionId });
        yield* drawOverlay({ type: "reply", id: JSON.stringify(id), failed: true });
        return yield* sink.answer(notSent(id));
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
        return yield* sink.answer(confirmation.refused ?? notSent(id));
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
          args: message?.params?.arguments,
          ...windowArgument(message?.params?.arguments),
          unfiltered: Object.keys(message?.params?.arguments ?? {}).every(
            (key) => key === "session",
          ),
          connectionId: current.connectionId,
          sink: verifier.wrap(sink, message, current),
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
      Math.min(permissionDeadline, primitiveDeadline),
    );
    if (outcome !== "sent" && id !== undefined && id !== null && isRequest) {
      const key = JSON.stringify(id);
      if (reservationId !== undefined)
        yield* release({ reservationId, connectionId: current.connectionId });
      yield* agentInput.ended(key);
      yield* drawOverlay({ type: "reply", id: key, failed: true });
      return yield* sink.answer(
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
  yield* forwardPrimitiveRequests(
    options.primitiveRequests,
    options.primitiveReply,
    () => `${PRIMITIVE_ID}${ownRequests++}`,
    forward,
    options.onPrimitiveSettled,
  );
  yield* options.input.pipe(Stream.runForEach((line) => forward(line, providerSink)));
  if (finished === undefined) yield* end("lost");
  return finished;
});
