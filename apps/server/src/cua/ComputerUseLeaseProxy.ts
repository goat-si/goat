/** The lease proxy cuts off outstanding calls and closes the driver when control ends. */
// JSON-RPC lines pass through unchanged; only the fields the proxy acts on are read.
// @effect-diagnostics preferSchemaOverJson:off
import type * as Contracts from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { proxyCallAdmission } from "./ComputerUseLeaseCallPermissions.ts";
import { makeTokenFirst } from "./ComputerUseTokenFirst.ts";
import { typeAutomationRefusal } from "./ComputerUseAutomationRefusal.ts";
import { typeManifestRefusal } from "./ComputerUseManifestRefusal.ts";
import * as Admission from "./ComputerUseLeaseProxyAdmission.ts";
import { makeLeaseProxyLifecycle, type Running } from "./ComputerUseLeaseProxyLifecycle.ts";
import { makeLeaseProxyHandshake } from "./ComputerUseLeaseProxyHandshake.ts";
import { watchLeaseProxyDeadlines } from "./ComputerUseLeaseProxyDeadline.ts";
import { makeLeaseFences } from "./leaseUpdateFences.ts";
import { makeProxyChecks } from "./ComputerUseLeaseProxyChecks.ts";
import { forwardProxyCursors } from "./ComputerUseLeaseProxyCursors.ts";
import { captureStalled, driverExitReason, driverRefused } from "./ComputerUseDriverOutcome.ts";
import { approvedApps, takesScreen } from "./ComputerUseScope.ts";
import { makeIdentityCache } from "./ComputerUseIdentityCache.ts";
import { narrowBatch } from "./ComputerUseBatchIdentity.ts";
import { makeProxyCallScope } from "./ComputerUseLeaseProxyPointBasis.ts";
import {
  makeProxyBrowserClaims,
  type SelectedClaim,
} from "./ComputerUseLeaseProxyBrowserClaims.ts";
import { makeAppLabels } from "./ComputerUseAppLabels.ts";
import { admitDriverReplyScreenshots, cancelledRequestKey } from "./ComputerUseDriverReply.ts";
import { type ComputerUseCallTarget, targetOf } from "./computerUseTarget.ts";
import { inputKinds } from "./agentInputLog.ts";
import { forwardHelperInput, makeAgentInputReports } from "./agentInputReports.ts";
import { makeOverlayDrawer } from "./agentCursorReports.ts";
import * as Cursor from "./ComputerUseCursorTools.ts";
import { resolveKeyCall } from "./ComputerUseKeyNames.ts";
import { replyImageSize } from "./ComputerUseOverlay.ts";
import { CAPTURE_HIDE_UNCONFIRMED, captureHidden } from "./ComputerUseCaptureHide.ts";
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
  RECONNECTING,
  REQUEST_ID_BUSY,
  SCREEN_CALL_EXPIRED,
  WRONG_DISPLAY,
} from "./ComputerUseLeaseMessages.ts";
import * as Transport from "./ComputerUseLeaseProxyTransport.ts";
import { refreshDriverManifest } from "./ComputerUseLeaseProxyManifest.ts";
import { makeUnansweredWatch } from "./ComputerUseLeaseProxyUnanswered.ts";
import {
  forwardPersonStop,
  latchedInterruption,
  makePersonStopFence,
  terminalSink,
  terminalForInterruption,
} from "./ComputerUseLeaseProxyPersonStop.ts";
import { startLeaseUpdates } from "./ComputerUseLeaseProxyUpdates.ts";
import {
  type JsonRpcId,
  UNCONFIRMED_DISPLAY,
  cutOff,
  interruptionDetail,
  interruptionRefusal,
  offScreenAnswer,
  refusal,
  unsentOutcome,
  unsentCallRefusal,
} from "./ComputerUseLeaseResponses.ts";
import {
  PRIMITIVE_ID,
  dispatchedPrimitives,
  forwardPrimitiveRequests,
  beginHops,
  outstandingCall,
  reservedProviderRequest,
  type OutstandingCall,
  type ReplySink,
  type LeaseProxyOptions,
} from "./ComputerUseLeaseProxyOptions.ts";
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
  let paused: Contracts.ComputerUsePauseReason | undefined;
  let idle = false;
  const personStop = makePersonStopFence();
  const fresh = { possibleCommit: false };
  const refuseFresh = refusal.bind(undefined, fresh);
  let apps: ReadonlySet<string> | undefined;
  let foreground: ReadonlyArray<Contracts.ComputerUseForegroundGrant> = [];
  const lifecycleLock = yield* Semaphore.make(1);
  let shared = false;
  // An older applied update cannot lift the latest receipt's restriction (sharedNow).
  let sharedTaken = false;
  const claims = makeProxyBrowserClaims(options.onBrowserClaimReport);
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
  let stalled: Running | undefined;
  const checkReply = (message: Envelope, tool: string | undefined, unfiltered: boolean) =>
    replyPlacement(options.placement, message, tool, unfiltered);
  const ownAnswers = new Map<string, Deferred.Deferred<Envelope | undefined>>();
  const handshakeAnswers = makeLeaseProxyHandshake({
    startDriver: options.startHandshakeDriver ?? options.startDriver,
    handshake,
    ownId: (kind) => OWN_ID + kind + ":" + ownRequests++,
    // Remembered answers are the driver's too (#1677).
    output: (line) => options.output(options.screenshots?.scrub(line) ?? line),
    ownAnswers,
    ended,
    endAnswer: (id, method, reason) => refuseFresh(id, method, reason, LEASE_END_MESSAGES[reason]),
    onCancelledRequestSettled: (key) => options.onCancelledRequestSettled?.(key),
  });
  const batches = makeProxyCallScope(handshakeAnswers, () => lifecycle.current, claims.report);
  const identities = makeIdentityCache();
  const listed = identities.listed;
  const labels = makeAppLabels();
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
    active: () => finished === undefined && paused === undefined && !idle && !personStop.pending(),
    overlay,
    targetClose: () => unanswered,
  });
  const providerSink: ReplySink = {
    answer: (line, _status, context) => options.output(line, context),
  };
  let lastInterruption: Interruption = { _tag: "end", reason: "helper_restarted" };
  /**
   * Retains each generation's calls through native closure so cancellation can suppress its
   * final answer without releasing ownership or touching a newer child.
   */
  const interrupt = Effect.fn("ComputerUseLeaseProxy.interrupt")(function* (cause: Interruption) {
    cause = latchedInterruption(cause, personStop.terminal());
    lastInterruption = cause;
    const message = interruptionRefusal(cause);
    const { token, current } = lifecycle.interrupt();
    if (current !== undefined && options.onDriverCutoff !== undefined)
      yield* options.onDriverCutoff({
        connectionId: current.connectionId,
        generation: current.generation,
        ...terminalForInterruption(cause, personStop.terminal()),
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
          ? cutOff(request.id, request.tool, cause, request.args, fresh)
          : refuseFresh(request.id, request.method, interruptionDetail(cause), message),
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

  const release = Admission.makeProxyRelease(options);
  const releaseLater = Admission.makeProxyReleaseLater(options, scope);

  const pauseForScreenLock = Effect.fn("ComputerUseLeaseProxy.screenLocked")(function* () {
    yield* overlay.screenLocked();
    yield* lifecycleLock.withPermits(1)(pause("screen_locked"));
    if (options.onScreenLocked !== undefined) yield* options.onScreenLocked();
  });

  // The buffer reads the driver apart from the replies' checks, so a driver that exits while a
  // reply waits on GOAT's capture is seen at once and that reply dropped (#1677).
  const readLines = (current: Running, exited: Deferred.Deferred<void>) => {
    // Runs for every driver line, so it opens no span of its own.
    const handle = Effect.fnUntraced(function* (line: string) {
      if (finished !== undefined || lifecycle.current !== current) return;
      const message = parse(line);
      let delivered = line;
      let tool: string | undefined;
      let sink = providerSink;
      if (message?.id !== undefined && message.id !== null && message.method === undefined) {
        const own = typeof message.id === "string" && message.id.startsWith(OWN_ID);
        // Only the answer to a list_apps request still waiting for it says which app a pid is.
        const listing = own
          ? String(message.id).startsWith(`${OWN_ID}apps:`) && ownAnswers.has(String(message.id))
          : outstanding.get(JSON.stringify(message.id))?.tool === "list_apps";
        identities.learn(message.result, listing, options.executableOf, labels);
        if (own) {
          const waiter = ownAnswers.get(message.id);
          ownAnswers.delete(message.id);
          if (waiter !== undefined) {
            if (personStop.beginLock(message)) {
              yield* pauseForScreenLock().pipe(Effect.forkIn(scope));
            }
            yield* Deferred.succeed(waiter, message);
          }
          return;
        }
        const key = JSON.stringify(message.id);
        const request = outstanding.get(key);
        // A reply to a request the provider cancelled, or never made, is stale.
        if (request === undefined) return;
        if (personStop.beginLock(message)) {
          yield* pauseForScreenLock().pipe(Effect.forkIn(scope));
        }
        identities.forget(message, request.args);
        if (request.hops !== undefined) request.hops.lineAt = yield* Clock.currentTimeMillis;
        // Stopped, ended, or answered by a pause or cancellation meanwhile.
        const gone = () =>
          finished !== undefined ||
          personStop.pending() ||
          lifecycle.current !== current ||
          !outstanding.has(key);
        sink = request.sink;
        // The marked line is the driver's reply from here on, screenshot rule included.
        if (request.method === "tools/call") {
          tool = request.tool;
          if (captureStalled(line)) stalled = current;
          const marked = tokenFirst.reply(request, message, line);
          line = typeManifestRefusal(
            typeAutomationRefusal(marked, options.automationHolder, request.args, listed),
          );
          delivered = line;
        }
        yield* agentInput.ended(key);
        if (request.cancelled) {
          yield* drawOverlay({ type: "reply", id: key, failed: true });
          yield* release(request, true, driverRefused(request.tool, message, request.args));
          if (gone() || paused !== undefined || idle) return;
          outstanding.delete(key);
          options.onCancelledRequestSettled?.(key);
          return;
        }
        if (claims.outside(message.result, request.browserClaim))
          return yield* claims.refuseReply(request, key, outstanding, gone, release);
        const session = message.result?.structuredContent?.session;
        if (request.method === "tools/call" && typeof session === "string") sessions.add(session);
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
          // Every answered call updates the overlay, a display refusal as failed, while the call
          // is still outstanding: a stop or pause during the draw answers it, and the check below
          // drops this reply.
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
          // A reply that shows the screen waits out a drop; the cut-off answers its call.
          const heldReply = () =>
            Transport.heldByTransport(options.transportHeld, request.method, request.tool);
          if (gone() || paused !== undefined || heldReply()) return;
          yield* releaseLater(request, true, driverRefused(request.tool, message, request.args));
          const latest = outstanding.get(key);
          if (gone() || paused !== undefined || idle || latest === undefined || heldReply()) return;
          outstanding.delete(key);
          if (latest.cancelled) return options.onCancelledRequestSettled?.(key);
          if (verdict === "other") {
            yield* request.sink.answer(
              offScreenAnswer(request.id, request.method, request.tool, "other", request.args),
              "settled",
            );
            return yield* end("wrong_display");
          }
          if (verdict === "unknown")
            return yield* request.sink.answer(
              offScreenAnswer(request.id, request.method, request.tool, "unknown", request.args),
              "settled",
            );
          if (verdict === "proof") proven = current;
        } else {
          batches.remember(current, request.method, message);
          outstanding.delete(key);
        }
      }
      if (delivered === line) delivered = options.screenshots?.scrub(line) ?? line;
      yield* sink.answer(admitDriverReplyScreenshots(delivered), "settled", { tool });
    });
    return current.driver.lines.pipe(
      Stream.onEnd(Deferred.succeed(exited, undefined)),
      Stream.tap(unanswered.received),
      Stream.buffer({ capacity: "unbounded" }),
      Stream.runForEach(handle),
      // A driver that exits on its own, or a helper restart, ends this proxy for good (#1348),
      // and the agent hears why instead of an approval failure (#1233).
      Effect.andThen(
        Effect.suspend(() =>
          lifecycle.current === current
            ? driverExitReason(current.driver).pipe(Effect.flatMap(end))
            : Effect.void,
        ),
      ),
    );
  };
  const active = () =>
    finished === undefined && paused === undefined && !idle && !personStop.pending();
  const lifecycle = yield* makeLeaseProxyLifecycle({
    connectionId: options.connectionId,
    firstGeneration: options.firstGeneration,
    startDriver: Transport.guardDriver(
      options.startDriver,
      options.transportHeld,
      Transport.settleProbe(ownAnswers, OWN_ID),
    ),
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
        yield* forwardPersonStop({
          events: driver.personStop,
          report: options.onPersonStop,
          active,
          current: () => lifecycle.current === current,
          fence: personStop,
          stop: lifecycleLock.withPermits(1)(end("stopped")),
          scope,
          driverScope: current.scope,
        });
        if (lifecycle.current !== current) return;
        overlay.reset();
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
  const unanswered = makeUnansweredWatch(
    { lock: lifecycleLock, scope, outstanding, lifecycle },
    { active, interrupt, start, end, fenced: (cause) => void (lastInterruption = cause) },
  );
  yield* unanswered.followCancels(options.subscribePrimitiveCancels);
  const pause = Effect.fn("ComputerUseLeaseProxy.pause")(function* (
    reason: Contracts.ComputerUsePauseReason,
  ) {
    if (finished !== undefined) return;
    const wasPaused = paused !== undefined;
    // Recorded first: a call drawing while this pause stopped its driver refuses with it.
    paused = reason;
    if (!wasPaused) {
      yield* drawOverlay({ type: "pause", reason });
      yield* interrupt({ _tag: "pause", reason });
    }
    yield* Deferred.succeed(confirmed, undefined);
    yield* Queue.offer(deadlineWake, undefined);
  }, Effect.uninterruptible);
  const activate = Effect.fn("ComputerUseLeaseProxy.activate")(function* (
    update: Extract<Contracts.ComputerUseLeaseUpdate, { readonly state: "active" }>,
  ) {
    if (!personStop.activate(update, paused, interruptionsSeen)) return;
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
    identities.scope(apps, next);
    apps = next;
    batches.grant(update.apps);
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
    identities.turn(update.identityEpoch ?? 0, missedIdle || idle);
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
  const transportDropped = Transport.dropTransport({
    running: () => finished === undefined && lifecycle.current !== undefined,
    calls: () => outstanding.values(),
    interrupt,
    start,
  }).pipe(lifecycleLock.withPermits(1), Effect.uninterruptible);
  yield* startLeaseUpdates({
    updates: options.leaseUpdates,
    controlId: options.controlId,
    fences,
    apps: () => apps,
    foreground: () => foreground,
    shared: (update) => {
      sharedTaken = update.shared === true;
      claims.update(update);
    },
    deadline: (value) => {
      deadline = value;
    },
    confirm: personStop.confirm,
    lock: lifecycleLock.withPermits(1),
    end,
    pause,
    idle: () => {
      idle = true;
    },
    interrupt,
    confirmed,
    activate,
    onApplied: options.onLeaseUpdateApplied,
    transportDropped,
    register: (receive, drop) => {
      options.onLeaseUpdateReceiver?.(receive);
      options.onTransportDropReceiver?.(Transport.settlingProbes(ownAnswers, OWN_ID, drop));
    },
  });

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
    refusal: (id, message, listApps, claimPid) => ({
      claimPid,
      id,
      message,
      finished: () => finished,
      paused: () => paused,
      idle: () => idle,
      apps: () => apps,
      listed,
      host: options,
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
  const refreshManifest = refreshDriverManifest({
    stamp: options.manifestStamp,
    current: () => lifecycle.current,
    stalled: () => stalled,
    quiet: () => paused === undefined && finished === undefined && !idle && outstanding.size === 0,
    stopped: () => paused !== undefined || finished !== undefined,
    interrupt,
    start,
  }).pipe(lifecycleLock.withPermits(1));
  const forward = Effect.fn("ComputerUseLeaseProxy.forward")(function* (
    incoming: string,
    rawSink: ReplySink,
    expectedConnection?: string,
    primitive?: Contracts.ComputerUsePrimitiveRequest,
  ) {
    yield* beginHops(primitive);
    const keyCall = resolveKeyCall(incoming);
    let line = "line" in keyCall ? keyCall.line : incoming;
    const decoded = decodeProviderIngress(line);
    if (decoded.kind === "invalid") return yield* rawSink.answer(decoded.response);
    let message = decoded.message;
    let dispatched = false;
    const sink = personStop.sink(rawSink, message, () => dispatched);
    // Reconnecting: nothing but a transport-safe read goes out, however far the call has got.
    const held = () =>
      Transport.heldByTransport(options.transportHeld, message.method, message.params?.name);
    // A received pause or end fences calls before the lifecycle lock becomes available.
    let selectedForeground: Contracts.ComputerUseForegroundGrant | undefined;
    let selectedClaim: SelectedClaim | undefined;
    const notSent = (requestId: JsonRpcId) =>
      personStop.refusal(requestId, message?.method) ??
      unsentCallRefusal(requestId, message?.method, {
        held: held(),
        pending: fences.pending(),
        finished,
        paused,
        idle,
        lastInterruption,
        foregroundRevoked:
          selectedForeground !== undefined && !fences.allowsForeground(selectedForeground),
      });
    const primitiveCurrent = () =>
      primitive === undefined || options.primitiveCancelled?.(primitive.requestId) !== true;
    const primitiveDeadline = primitive?.deadlineMillis ?? Infinity;
    const primitiveAllowed = Clock.currentTimeMillis.pipe(
      Effect.map(
        (now) => primitiveCurrent() && now < primitiveDeadline && !held() && !personStop.pending(),
      ),
    );
    if (expectedConnection !== undefined && lifecycle.current?.connectionId !== expectedConnection)
      return yield* sink.answer(staleGeneration(message.id ?? "", "tools/call"), "not_started");
    const id = message.id;
    const isRequest = id !== undefined && id !== null && message?.method !== undefined;
    const reserved = reservedProviderRequest(id, message.method, expectedConnection);
    if (reserved !== undefined) return yield* sink.answer(reserved);
    const cancelled = cancelledRequestKey(line);
    if (cancelled !== undefined) {
      handshakeAnswers.cancel(cancelled);
      // The driver may ignore cancellation; ownership lasts until its reply or actual cutoff.
      personStop.cancel(outstanding.get(cancelled));
    }
    const key = isRequest ? JSON.stringify(id) : "";
    if (isRequest && (outstanding.has(key) || handshakeAnswers.pending(key)))
      return yield* sink.answer(refuseFresh(id, message.method, "invalid_target", REQUEST_ID_BUSY));
    if (message?.method === "initialize" || message?.method === "notifications/initialized")
      handshake.push(line);
    if (finished !== undefined) {
      if (isRequest)
        yield* sink.answer(
          refuseFresh(id, message?.method, finished, LEASE_END_MESSAGES[finished]),
        );
      return;
    }
    if ("answer" in keyCall) return yield* sink.answer(keyCall.answer);
    if (isRequest && message?.method === "tools/call") {
      const pendingRefusal = personStop.refusal(id, message.method);
      if (pendingRefusal !== undefined) return yield* sink.answer(pendingRefusal);
      yield* Effect.raceFirst(Deferred.await(confirmed), Deferred.await(ended).pipe(Effect.asVoid));
      if (held()) return yield* sink.answer(notSent(id));
      if (!primitiveCurrent() || (yield* Clock.currentTimeMillis) >= primitiveDeadline)
        return yield* sink.answer(refuseFresh(id, message.method, "expired", SCREEN_CALL_EXPIRED));
      const browser = claims.gate(id, line, message, primitive?.authority);
      if (browser.refused !== undefined) return yield* sink.answer(browser.refused);
      ({ line, message, selected: selectedClaim } = browser);
      if (
        expectedConnection !== undefined &&
        lifecycle.current?.connectionId !== expectedConnection
      )
        return yield* sink.answer(staleGeneration(id, message.method), "not_started");
      // A call belongs to its admitted child; only a manifest refresh may replace it.
      let admitted = lifecycle.current;
      const refreshed =
        options.manifestStamp === undefined || lifecycle.current === undefined || !active()
          ? undefined
          : yield* refreshManifest;
      if (refreshed !== undefined) identities.clear();
      if (refreshed !== undefined) admitted = refreshed;
      if (
        expectedConnection !== undefined &&
        lifecycle.current?.connectionId !== expectedConnection
      )
        return yield* sink.answer(staleGeneration(id, message.method), "not_started");
      const unsupported = yield* claims.unsupported(
        selectedClaim,
        batches.browserSupported,
        id,
        message.method,
      );
      if (unsupported !== undefined) return yield* sink.answer(unsupported);
      const batch = yield* batches.scope(id, line, message, () => notSent(id));
      if ("refused" in batch) return yield* sink.answer(batch.refused);
      ({ line, message } = batch);
      const tool = typeof message.params?.name === "string" ? message.params.name : undefined;
      const needsProof =
        options.placement !== undefined && (tool === undefined || !DISPLAY_PROOF_FREE.has(tool));
      if (options.placement !== undefined && finished === undefined && paused === undefined) {
        const targets = namedWindows(message.params?.arguments);
        if (targets === undefined)
          return yield* sink.answer(
            refuseFresh(id, message.method, "wrong_display", UNCONFIRMED_DISPLAY),
          );
        if (targets.length > 0 && (yield* options.placement(targets)) !== "same")
          return yield* sink.answer(
            refuseFresh(id, message.method, "wrong_display", WRONG_DISPLAY),
          );
        if (needsProof) yield* proveDisplay(primitiveAllowed);
      }
      if (personStop.pending()) return yield* sink.answer(notSent(id));
      const refused = yield* refuseCall(id, message, primitiveAllowed, selectedClaim?.pid);
      if (personStop.pending()) return yield* sink.answer(notSent(id));
      if (held()) return yield* sink.answer(notSent(id));
      if (refused !== undefined) return yield* sink.answer(refused);
      const narrowed = narrowBatch(id, line, message, listed, options.bundleIds);
      if ("refused" in narrowed) return yield* sink.answer(narrowed.refused);
      ({ line, message } = narrowed);
      if (admitted !== undefined && lifecycle.current !== admitted)
        return yield* sink.answer(
          refuseFresh(
            id,
            message.method,
            interruptionDetail(lastInterruption),
            interruptionRefusal(lastInterruption),
          ),
        );
      if (needsProof && (lifecycle.current === undefined || proven !== lifecycle.current))
        return yield* sink.answer(
          finished === undefined && options.transportHeld?.() === true
            ? refuseFresh(id, message.method, "reconnecting", RECONNECTING)
            : refuseFresh(
                id,
                message.method,
                "wrong_display",
                finished === "wrong_display"
                  ? LEASE_END_MESSAGES.wrong_display
                  : UNCONFIRMED_DISPLAY,
              ),
        );
      const session = message.params?.arguments?.session;
      if (typeof session === "string" && session.length > 0) sessions.add(session);
    }
    if (isRequest && !(yield* unanswered.hold(primitiveDeadline)))
      return yield* sink.answer(notSent(id));
    // Paused: no driver until control comes back. The handshake is still answered in the
    // background (#1604); tool calls hear the pause.
    if (lifecycle.current === undefined) {
      if (!isRequest || message.method === undefined) return;
      const refuse = sink.answer(
        refuseFresh(
          id,
          message.method,
          "waiting_for_human",
          PAUSE_MESSAGES[paused ?? "human_input"],
        ),
      );
      return yield* handshakeAnswers.covers(message.method)
        ? handshakeAnswers.answer(id, message.method, line, refuse).pipe(Effect.forkIn(scope))
        : refuse;
    }
    // The child this line goes to. Replaced before the send below, the call is refused; once
    // sent, an interruption answers it as cut off (interrupt above).
    const current = lifecycle.current;
    const stillCurrent = () =>
      lifecycle.current === current &&
      primitiveCurrent() &&
      !unanswered.blocks(current.connectionId) &&
      (expectedConnection === undefined || current.connectionId === expectedConnection) &&
      !idle &&
      !personStop.pending() &&
      paused === undefined &&
      finished === undefined &&
      !held() &&
      claims.allowed(selectedClaim, message) &&
      fences.clear() &&
      (selectedForeground === undefined || fences.allowsForeground(selectedForeground));
    const name = message?.method === "tools/call" ? message.params?.name : undefined;
    const args = message?.params?.arguments;
    if (isRequest && options.answersCursorTools && Cursor.answeredByHelperCursor(name, args)) {
      if (!stillCurrent()) return yield* sink.answer(notSent(id));
      const line = yield* Cursor.answerHelperCursorCall(id, String(name), args, overlay);
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
        ...(primitive?.cursor === undefined ? {} : { cursor: primitive.cursor }),
      });
      if (!stillCurrent()) return yield* sink.answer(notSent(id));
      if (
        !(yield* captureHidden(
          current.driver.overlay,
          message.params?.name,
          message.params?.arguments,
        ))
      ) {
        yield* drawOverlay({ type: "reply", id: JSON.stringify(id), failed: true });
        return yield* sink.answer(
          refuseFresh(id, message.method, "capture_hide_unconfirmed", CAPTURE_HIDE_UNCONFIRMED),
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
      const admission = yield* Admission.reserveProxyCall(options, {
        id,
        message,
        connectionId: current.connectionId,
        callId: String(ownRequests++),
        interruptions: interruptionsSeen ?? 0,
        idleEpoch: idleEpochSeen ?? 0,
        claimPid: selectedClaim?.pid,
        foreground,
        scope: { listed, apps, labels },
      });
      selectedForeground = admission.selectedForeground;
      reservationId = admission.reservationId;
      permissionDeadline = admission.deadline;
      if (!stillCurrent() || admission.refused !== undefined) {
        if (reservationId !== undefined)
          yield* release({ reservationId, connectionId: current.connectionId }, undefined, true);
        yield* drawOverlay({ type: "reply", id: JSON.stringify(id), failed: true });
        return yield* sink.answer(admission.refused ?? notSent(id));
      }
    }
    if (isRequest && options.answersCursorTools && Cursor.isWindowCursorMove(name, args)) {
      const answer = yield* Cursor.answerWindowCursorMove(id, args, overlay, drawOverlay);
      if (reservationId !== undefined)
        yield* release({ reservationId, connectionId: current.connectionId });
      return yield* sink.answer(answer, "settled", { tool: "move_cursor" });
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
          refuseFresh(
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
          yield* release({ reservationId, connectionId: current.connectionId }, undefined, true);
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
        yield* release({ reservationId, connectionId: current.connectionId }, undefined, true);
        yield* agentInput.ended(JSON.stringify(id));
        yield* drawOverlay({ type: "reply", id: JSON.stringify(id), failed: true });
        return yield* sink.answer(confirmation.refused ?? notSent(id));
      }
    }
    // The last checks, the call's registration and the write run as one step with no scheduler
    // yield (sendUnlessShared, #1496): a pause, narrowing or another thread's grant that lands
    // first keeps the call unsent and unregistered, so it is answered as not run.
    const register = (sentAt: number) =>
      Effect.sync(() => {
        if (!isRequest) return;
        dispatched = true;
        if (primitive !== undefined) dispatchedPrimitives.add(primitive);
        const sent = claims.attach(
          outstandingCall(message!, id, sentAt, current, sink, reservationId, primitive),
          selectedClaim,
        );
        outstanding.set(JSON.stringify(id), sent);
      });
    const outcome = yield* sendUnlessShared(
      isRequest &&
        message?.method === "tools/call" &&
        takesScreen(message.params?.name, message.params?.arguments),
      sharedNow,
      stillCurrent,
      (now) => register(now).pipe(Effect.andThen(current.driver.send(line))),
      Math.min(permissionDeadline, primitiveDeadline),
    );
    if (outcome !== "sent" && id !== undefined && id !== null && isRequest) {
      const key = JSON.stringify(id);
      if (reservationId !== undefined)
        yield* release({ reservationId, connectionId: current.connectionId }, undefined, true);
      yield* agentInput.ended(key);
      yield* drawOverlay({ type: "reply", id: key, failed: true });
      return yield* sink.answer(unsentOutcome(outcome, id, message?.method, () => notSent(id)));
    }
    if (primitive !== undefined && isRequest)
      yield* unanswered.watch(JSON.stringify(id), primitiveDeadline);
  });
  yield* forwardPrimitiveRequests(
    options.primitiveRequests,
    options.primitiveReply,
    () => `${PRIMITIVE_ID}${ownRequests++}`,
    forward,
    options.onPrimitiveSettled,
    (sink, id, request) =>
      terminalSink(
        sink,
        { id, method: "tools/call", params: { name: request.tool } },
        personStop.capture(),
        () => false,
      ),
  );
  yield* options.input.pipe(Stream.runForEach((line) => forward(line, providerSink)));
  if (finished === undefined) yield* end("lost");
  return finished;
});
