/** One MCP transport, with an isolated legacy proxy and reservation generation per control. */
// @effect-diagnostics preferSchemaOverJson:off -- MCP envelopes retain the client's opaque fields.
import type {
  ComputerUseControlEnd,
  ComputerUseLeaseThreadUpdate,
  ComputerUseLeaseUpdate,
  ComputerUsePrimitiveRequest,
} from "@goat/contracts";
import type * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { cancelledRequestKey } from "./ComputerUseDriverReply.ts";
import { type Envelope, decodeProviderIngress, parse } from "./ComputerUseLeaseProtocol.ts";
import {
  type LeaseEnd,
  LEASE_END_MESSAGES,
  RECONNECTING,
  REQUEST_ID_BUSY,
} from "./ComputerUseLeaseMessages.ts";
import { watchLeaseProxyDeadlines } from "./ComputerUseLeaseProxyDeadline.ts";
import { runLeaseProxy } from "./ComputerUseLeaseProxy.ts";
import { makeLeaseProxyHandshake } from "./ComputerUseLeaseProxyHandshake.ts";
import { primitiveReplySink, type LeaseProxyOptions } from "./ComputerUseLeaseProxyOptions.ts";
import { terminalSink } from "./ComputerUseLeaseProxyPersonStop.ts";
import { type JsonRpcId, refusal, reservedIdAnswer } from "./ComputerUseLeaseResponses.ts";
import type { LeaseTransportUpdate } from "./ComputerUseLeaseStreamFollower.ts";
import {
  mergeTerminal,
  terminalReason,
  type ComputerUseTerminalReason,
} from "./ComputerUseTerminal.ts";

type Reports<EU, ED> = Pick<
  LeaseProxyOptions<EU, ED>,
  "onTarget" | "onCursor" | "onHumanInput" | "onAgentInput" | "onPersonStop" | "onScreenLocked"
>;
type ThreadProxyOptions<EU, ED> = Omit<
  LeaseProxyOptions<EU, ED>,
  "controlId" | "expiresAt" | "leaseUpdates" | keyof Reports<EU, ED>
> & {
  /** The server's updates and the follower's transport state; its end ends the proxy. */
  readonly leaseUpdates: Stream.Stream<ComputerUseLeaseThreadUpdate | LeaseTransportUpdate, EU>;
  /** Captured once, so even delayed reports belong to the control that produced them. */
  readonly reports: (controlId: string) => Reports<EU, ED>;
  readonly onControlDriverStarted?: (
    controlId: string,
    current: { readonly connectionId: string; readonly generation: number },
  ) => Effect.Effect<void>;
  readonly onControlDriverCutoff?: (
    controlId: string,
    current: {
      readonly connectionId: string;
      readonly generation: number;
      readonly terminal?: "stopped_by_person" | "screen_locked";
    },
  ) => Effect.Effect<void>;
  /** Runs after the supervisor has routed an update, without waiting for native teardown. */
  readonly onThreadUpdate?: (
    update: ComputerUseLeaseThreadUpdate | LeaseTransportUpdate,
  ) => Effect.Effect<void>;
};

const OWN_ID = "goat-thread-proxy:";
const WAITING = "Computer use is not available for this turn.";
const replySafety = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      result: Schema.Struct({
        structuredContent: Schema.Struct({
          safety: Schema.Struct({ possibleCommit: Schema.Boolean }),
        }),
      }),
    }),
  ),
);
type ControlStop = ComputerUseControlEnd | "lost" | "transport_lost";

interface Context {
  readonly controlId: string;
  readonly input: Queue.Queue<string, Cause.Done>;
  readonly primitiveInput: Queue.Queue<ComputerUsePrimitiveRequest>;
  readonly updates: Array<ComputerUseLeaseUpdate | undefined>;
  receive?: (update: ComputerUseLeaseUpdate | undefined) => void;
  ready: boolean;
  readonly closed: Deferred.Deferred<void>;
  readonly replayIds: Set<string>;
  readonly wake: Queue.Queue<void>;
  deadline: number;
  ended?: LeaseEnd;
  terminal: { reason?: ComputerUseTerminalReason | undefined };
  driverGeneration?: number;
  readonly driverTerminals: Map<number, { reason?: ComputerUseTerminalReason | undefined }>;
  /** Cuts off the driver's screen work when the lease stream drops; set once the proxy runs. */
  dropTransport?: () => void;
}

export const runThreadLeaseProxy = Effect.fn("ComputerUseLeaseProxyThread.run")(function* <EU, ED>(
  options: ThreadProxyOptions<EU, ED>,
) {
  const scope = yield* Effect.scope;
  let current: Context | undefined;
  let predecessor: Context | undefined;
  let terminal: LeaseEnd | undefined;
  let waiting: LeaseEnd = "stopped";
  /**
   * Between a dropped lease stream and the server's next update no Stop or pause can arrive, so
   * screen calls are held; "lost" once the reconnect window passed.
   */
  let transport: "connected" | "reconnecting" | "lost" = "connected";
  let sequence = 0;
  const seen = new Set<string>();
  const controlTerminals = new Map<string, { reason?: ComputerUseTerminalReason | undefined }>();
  /** The newest driver generation per control, so a control started again never reuses one. */
  const generations = new Map<string, number>();
  const handshake: Array<string> = [];
  const ended = yield* Deferred.make<LeaseEnd>();
  const owners = new Map<
    string,
    {
      context: Context;
      latch: Context["terminal"];
      message: Envelope;
      id: JsonRpcId;
      method: string;
      cancelled: boolean;
      answering?: boolean;
    }
  >();
  const clientRequests = new Map<string, { context: Context; id: JsonRpcId }>();
  const ownAnswers = new Map<string, Deferred.Deferred<Envelope | undefined>>();
  const setup = makeLeaseProxyHandshake({
    startDriver: options.startHandshakeDriver ?? options.startDriver,
    handshake,
    ownId: (kind) => `${OWN_ID}${kind}:${sequence++}`,
    // A replayed handshake answer is the driver's too: its images follow the same rule (#1677).
    output: (line) => options.output(options.screenshots?.scrub(line) ?? line),
    ownAnswers,
    ended,
    endAnswer: (id, method, reason) => refusal(id, method, reason, LEASE_END_MESSAGES[reason]),
  });
  const answerStopped = Effect.fn("ComputerUseLeaseProxyThread.answerStopped")((
    id: JsonRpcId,
    method: string | undefined,
    given?: LeaseEnd,
    context: Context | undefined = current ?? predecessor,
    latch: Context["terminal"] | undefined = context?.terminal,
    dispatched = false,
  ) => {
    const personStopped = latch?.reason === "stopped_by_person";
    if (
      given === undefined &&
      terminal === undefined &&
      transport === "reconnecting" &&
      latch?.reason === undefined
    )
      return terminalSink(
        { answer: (line, _status, context) => options.output(line, context) },
        { id, ...(method === undefined ? {} : { method }) },
        () => latch?.reason,
        () => false,
      ).answer(refusal(id, method, "reconnecting", RECONNECTING));
    const candidate =
      given ??
      terminal ??
      (personStopped
        ? "stopped"
        : transport === "lost"
          ? "transport_lost"
          : (context?.ended ?? waiting));
    const reason =
      (candidate === "stopped" || candidate === "stopped_all") && !personStopped
        ? "reconnecting"
        : candidate;
    const answer = refusal(
      id,
      method,
      reason,
      reason === "reconnecting"
        ? transport === "reconnecting"
          ? RECONNECTING
          : WAITING
        : terminal !== undefined || personStopped || reason === "transport_lost"
          ? LEASE_END_MESSAGES[reason]
          : reason === "disabled"
            ? "Computer use is turned off in settings. Re-enable it, then start a new turn or approval."
            : WAITING,
    );
    return terminalSink(
      { answer: (line, _status, context) => options.output(line, context) },
      { id, ...(method === undefined ? {} : { method }) },
      () => latch?.reason,
      () => dispatched,
    ).answer(answer);
  });

  const pruneEpochs = (context: Context) => {
    for (const [generation, epoch] of context.driverTerminals)
      if (
        generation !== context.driverGeneration &&
        ![...owners.values()].some((owner) => owner.context === context && owner.latch === epoch)
      )
        context.driverTerminals.delete(generation);
  };
  const output = (context: Context, line: string, reply?: { readonly tool?: string | undefined }) =>
    Effect.suspend(() => {
      const message = parse(line);
      const cancelled = cancelledRequestKey(line);
      if (cancelled !== undefined) {
        for (const [key, owner] of clientRequests) {
          if (owner.context !== context || JSON.stringify(owner.id) !== cancelled) continue;
          clientRequests.delete(key);
          const params = message?.params;
          return options.output(
            JSON.stringify({
              ...message,
              params: { ...params, requestId: key },
            }),
          );
        }
        return Effect.void;
      }
      if (message?.method !== undefined && message.id !== undefined && message.id !== null) {
        if (context.ended !== undefined || terminal !== undefined) return Effect.void;
        const id = `${OWN_ID}client:${sequence++}`;
        clientRequests.set(id, { context, id: message.id });
        return options.output(JSON.stringify({ ...message, id }));
      }
      if (message?.method === undefined && message?.id !== undefined && message.id !== null) {
        const own = typeof message.id === "string" ? ownAnswers.get(message.id) : undefined;
        if (own !== undefined) {
          ownAnswers.delete(String(message.id));
          return Deferred.succeed(own, message).pipe(Effect.asVoid);
        }
        const key = JSON.stringify(message.id);
        if (context.replayIds.delete(key)) return Effect.void;
        const owner = owners.get(key);
        if (owner?.context !== context) return Effect.void;
        if (owner.answering) return Effect.void;
        if (owner.cancelled) {
          owners.delete(key);
          pruneEpochs(context);
          return Effect.void;
        }
        owner.answering = true;
        setup.remember(owner.method, message);
        const safety = replySafety(line);
        return terminalSink(
          { answer: (answer, _status, result) => options.output(answer, result) },
          owner.message,
          () => owner.latch.reason,
          () =>
            safety._tag === "None" || safety.value.result.structuredContent.safety.possibleCommit,
        )
          .answer(line, undefined, reply)
          .pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (owners.get(key) === owner) owners.delete(key);
                pruneEpochs(context);
              }),
            ),
          );
      }
      return options.output(line, reply);
    });

  const receive = (context: Context, update: ComputerUseLeaseUpdate | undefined) => {
    if (update?.state === "paused" && update.reason === "screen_locked") {
      latchOwners(context.controlId, "screen_locked");
      latchCurrent(context, "screen_locked");
    } else if (update?.state === "active" && context.terminal.reason === "screen_locked") {
      context.terminal = {};
      controlTerminals.set(context.controlId, context.terminal);
    }
    if (context.receive === undefined) context.updates.push(update);
    else context.receive(update);
  };
  const latchOwners = (controlId: string, reason: ComputerUseTerminalReason) => {
    for (const owner of owners.values())
      if (owner.context.controlId === controlId)
        owner.latch.reason = mergeTerminal(owner.latch, { reason }).reason;
  };
  const latchCurrent = (context: Context, reason: ComputerUseTerminalReason) => {
    context.terminal.reason = mergeTerminal(context.terminal, { reason }).reason;
    if (reason === "stopped_by_person")
      for (const latch of context.driverTerminals.values())
        latch.reason = mergeTerminal(latch, { reason }).reason;
  };
  // Receipt and routing must change in one synchronous step, before any Effect can yield.
  const stop = (context: Context, reason: ControlStop) => {
    if (context.ended !== undefined) return;
    context.ended = reason;
    if (reason === "stopped" || reason === "stopped_all") {
      latchOwners(context.controlId, "stopped_by_person");
      latchCurrent(context, "stopped_by_person");
    }
    context.ready = false;
    if (current === context) current = undefined;
    Queue.shutdownUnsafe(context.primitiveInput);
    waiting = reason;
    for (const [key, owner] of clientRequests)
      if (owner.context === context) clientRequests.delete(key);
    if (reason !== "lost" && reason !== "transport_lost")
      return receive(context, { state: "ended", reason });
    receive(context, undefined);
    // No server end will close this control's input; a successor for the same id waits on it.
    Queue.endUnsafe(context.input);
  };
  const finishNow = (reason: ComputerUseControlEnd | "lost") => {
    if (terminal !== undefined) return;
    terminal = reason;
    if (current !== undefined) stop(current, reason);
    Deferred.doneUnsafe(ended, Exit.succeed(reason));
  };
  const finish = Effect.fn("ComputerUseLeaseProxyThread.finish")(
    (reason: ComputerUseControlEnd | "lost") => Effect.sync(() => finishNow(reason)),
  );

  const select = Effect.fn("ComputerUseLeaseProxyThread.selectControl")(function* (
    update: Extract<ComputerUseLeaseThreadUpdate, { state: "active" | "paused" | "idle" }>,
  ) {
    const expiresAt = DateTime.make(update.expiresAt);
    if (Option.isNone(expiresAt)) return yield* finish("lost");
    if (current?.controlId === update.controlId) {
      // The server's latest word: a reused control's expiry moves later with its last use.
      current.deadline = DateTime.toEpochMillis(expiresAt.value);
      yield* Queue.offer(current.wake, undefined);
      return;
    }
    // A stopped/expired id cannot be revived by a delayed snapshot from the subscription.
    if (seen.has(update.controlId)) return;
    seen.add(update.controlId);
    const previous = predecessor;
    const context: Context = {
      controlId: update.controlId,
      input: yield* Queue.unbounded<string, Cause.Done>(),
      primitiveInput: yield* Queue.dropping<ComputerUsePrimitiveRequest>(16),
      updates: [],
      ready: false,
      closed: yield* Deferred.make<void>(),
      replayIds: new Set(),
      wake: yield* Queue.sliding<void>(1),
      deadline: DateTime.toEpochMillis(expiresAt.value),
      terminal: controlTerminals.get(update.controlId) ?? {},
      driverTerminals: new Map(),
    };
    controlTerminals.set(context.controlId, context.terminal);
    const connectionId = `${options.connectionId}:control:${sequence++}`;
    const reports = options.reports(context.controlId);
    receive(context, update);
    current = context;
    predecessor = context;
    // The supervisor stops routing at local expiry too; the legacy proxy keeps its own guard.
    yield* Effect.raceFirst(
      watchLeaseProxyDeadlines({
        wake: context.wake,
        controlDeadline: () => context.deadline,
        foregroundDeadline: () => Infinity,
        expireControl: Effect.sync(() => stop(context, "expired")),
        expireForeground: () => Effect.void,
      }),
      Deferred.await(context.closed),
    ).pipe(Effect.forkIn(scope));
    yield* Effect.gen(function* () {
      const controlScope = yield* Effect.scope;
      if (previous !== undefined) yield* Deferred.await(previous.closed);
      if (context.ended !== undefined || terminal !== undefined) return;
      let rechecked = false;
      let replayed = false;
      const reason = yield* runLeaseProxy({
        ...options,
        ...reports,
        connectionId,
        controlId: context.controlId,
        expiresAt: expiresAt.value,
        firstGeneration: (generations.get(context.controlId) ?? -1) + 1,
        transportHeld: () => transport !== "connected",
        onTransportDropReceiver: (drop) => {
          context.dropTransport = drop;
        },
        input: Stream.fromQueue(context.input),
        primitiveRequests: Stream.fromQueue(context.primitiveInput),
        onDriverStarted: Effect.fn("ComputerUseLeaseProxyThread.driverStarted")((driver) => {
          const previous =
            context.driverGeneration === undefined
              ? undefined
              : context.driverTerminals.get(context.driverGeneration);
          if (previous === context.terminal && previous?.reason !== undefined) {
            context.terminal = {};
            controlTerminals.set(context.controlId, context.terminal);
          }
          context.driverGeneration = driver.generation;
          context.driverTerminals.set(driver.generation, context.terminal);
          pruneEpochs(context);
          generations.set(
            context.controlId,
            Math.max(generations.get(context.controlId) ?? -1, driver.generation),
          );
          return options.onControlDriverStarted?.(context.controlId, driver) ?? Effect.void;
        }),
        onDriverCutoff: (driver) => {
          if (driver.terminal !== undefined) {
            if (generations.get(context.controlId) === driver.generation)
              latchOwners(context.controlId, driver.terminal);
            const latch = context.driverTerminals.get(driver.generation);
            if (latch === context.terminal) latchCurrent(context, driver.terminal);
            else if (latch !== undefined)
              latch.reason = mergeTerminal(latch, { reason: driver.terminal }).reason;
          }
          return options.onControlDriverCutoff?.(context.controlId, driver) ?? Effect.void;
        },
        output: (line, reply) => output(context, line, reply),
        leaseUpdates: Stream.never,
        onLeaseUpdateReceiver: (take) => {
          context.receive = take;
          for (const update of context.updates) take(update);
          context.updates.length = 0;
        },
        onCancelledRequestSettled: (key) => {
          if (owners.get(key)?.context === context) {
            owners.delete(key);
            pruneEpochs(context);
          }
        },
        onLeaseUpdateApplied: Effect.fn("ComputerUseLeaseProxyThread.appliedUpdate")(
          function* (applied) {
            if (!replayed && context.ended === undefined && terminal === undefined) {
              // Include setup received during native closure; replay precedes live instance input.
              for (const line of handshake) {
                const message = parse(line);
                if (message?.method === "initialize") {
                  const id = `${OWN_ID}initialize:${sequence++}`;
                  context.replayIds.add(JSON.stringify(id));
                  Queue.offerUnsafe(context.input, JSON.stringify({ ...message, id }));
                } else Queue.offerUnsafe(context.input, line);
              }
              replayed = true;
              context.ready = true;
            }
            if (!rechecked && applied.state === "active") {
              rechecked = true;
              yield* setup
                .recheck((line) => Queue.offer(context.input, line).pipe(Effect.asVoid))
                .pipe(Effect.forkIn(controlScope));
            }
            yield* options.onLeaseUpdateApplied?.(applied) ?? Effect.void;
            if (applied.state === "ended") {
              // Legacy end has already killed the native child, closed its scope and reservations.
              yield* Deferred.succeed(context.closed, undefined);
              yield* Queue.end(context.input);
            }
          },
        ),
      }).pipe(Effect.scoped);
      if (reason !== undefined) context.ended ??= reason;
    }).pipe(
      Effect.scoped,
      Effect.catchCause(() => finish("lost")),
      Effect.ensuring(
        Effect.gen(function* () {
          // Local expiry or native exit also makes this id permanently unavailable.
          if (current === context) {
            current = undefined;
            waiting = context.ended ?? terminal ?? "lost";
          }
          for (const [key, owner] of clientRequests)
            if (owner.context === context) clientRequests.delete(key);
          for (const [key, owner] of owners) {
            if (owner.context !== context) continue;
            if (owner.answering) continue;
            if (!owner.cancelled)
              yield* answerStopped(
                owner.id,
                owner.method,
                context.ended ?? terminal ?? "lost",
                context,
                owner.latch,
                true,
              );
            if (owners.get(key) === owner) owners.delete(key);
            pruneEpochs(context);
          }
          yield* Deferred.succeed(context.closed, undefined);
        }),
      ),
      Effect.forkIn(scope),
    );
  });

  const take = Effect.fn("ComputerUseLeaseProxyThread.takeUpdate")(
    (update: ComputerUseLeaseThreadUpdate | LeaseTransportUpdate) =>
      Effect.suspend(() => {
        if (update.state === "reconnecting" || update.state === "transport_lost") {
          if (terminal === undefined) {
            transport = update.state === "reconnecting" ? "reconnecting" : "lost";
            if (update.state === "reconnecting") current?.dropTransport?.();
            // The driver and its sessions stay up while reconnecting. Past the window the control
            // ends here, and a fresh server snapshot of the same id may start it again: unlike a
            // delayed snapshot on a live stream, a new connection reports the current state.
            if (update.state === "transport_lost" && current !== undefined) {
              seen.delete(current.controlId);
              stop(current, "transport_lost");
            }
          }
          return options.onThreadUpdate?.(update) ?? Effect.void;
        }
        // Any server update is the current state again; it applies before the next call routes.
        transport = "connected";
        if (update.state === "primitive-request" || update.state === "primitive-cancel")
          return Effect.void;
        if (terminal === undefined) {
          if (update.state === "ended") finishNow(update.reason);
          else if (update.state === "control-ended") {
            seen.add(update.controlId);
            if (update.reason === "stopped" || update.reason === "stopped_all") {
              latchOwners(update.controlId, "stopped_by_person");
              const latch = controlTerminals.get(update.controlId) ?? {};
              if (current?.controlId !== update.controlId)
                latch.reason = mergeTerminal(latch, { reason: "stopped_by_person" }).reason;
              controlTerminals.set(update.controlId, latch);
            }
            if (current?.controlId === update.controlId) stop(current, update.reason);
            else if (current === undefined) waiting = update.reason;
          } else if (update.state === "waiting") {
            if (current !== undefined) stop(current, "replaced");
          } else if (current?.controlId === update.controlId) receive(current, update);
          else if (current !== undefined) stop(current, "replaced");
        }
        return Effect.gen(function* () {
          if (
            terminal === undefined &&
            (update.state === "active" || update.state === "paused" || update.state === "idle")
          )
            yield* select(update);
          yield* options.onThreadUpdate?.(update) ?? Effect.void;
        });
      }),
  );

  yield* options.leaseUpdates.pipe(
    Stream.runForEach(take),
    Effect.catchCause(() => Effect.void),
    Effect.andThen(finish("lost")),
    Effect.forkScoped,
  );

  if (options.primitiveRequests !== undefined)
    yield* options.primitiveRequests.pipe(
      Stream.runForEach((request) =>
        Effect.gen(function* () {
          const context = current;
          if (
            context !== undefined &&
            context.ready &&
            context.ended === undefined &&
            context.controlId === request.controlId &&
            terminal === undefined &&
            (yield* Queue.offer(context.primitiveInput, request).pipe(
              Effect.orElseSucceed(() => false),
            ))
          )
            return;
          const reason = terminalReason(controlTerminals.get(request.controlId)?.reason);
          if (reason === undefined) {
            yield* options.primitiveReply?.({ ...request, status: "not_started" }) ?? Effect.void;
            options.onPrimitiveSettled?.(request.requestId);
            return;
          }
          const sink = terminalSink(
            primitiveReplySink(request, options.primitiveReply),
            { id: request.callId, method: "tools/call", params: { name: request.tool } },
            () => reason,
            () => false,
          );
          yield* sink.answer(
            refusal(request.callId, "tools/call", "invalid_target", WAITING),
            "not_started",
          );
          options.onPrimitiveSettled?.(request.requestId);
        }),
      ),
      Effect.forkScoped,
    );

  const handle = Effect.fn("ComputerUseLeaseProxyThread.routeMessage")(function* (line: string) {
    const decoded = decodeProviderIngress(line);
    if (decoded.kind === "invalid") {
      const latch = (current ?? predecessor)?.terminal;
      return yield* terminalSink(
        { answer: (answer, _status, context) => options.output(answer, context) },
        { id: null },
        () => latch?.reason,
        () => false,
      ).answer(decoded.response);
    }
    const message = decoded.message;
    if (message.method === "$/cancelRequest") {
      const params = message.params as { readonly id?: unknown } | undefined;
      if (typeof params?.id === "string" || typeof params?.id === "number")
        line = JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: params.id },
        });
    }
    const cancelled = cancelledRequestKey(line);
    if (cancelled !== undefined) {
      setup.cancel(cancelled);
      const owner = owners.get(cancelled);
      if (owner !== undefined) {
        owner.cancelled = true;
        yield* Queue.offer(owner.context.input, line);
      }
      return;
    }
    const id = message?.id;
    if (id !== undefined && id !== null && message?.method === undefined) {
      const key = String(id);
      const owner = clientRequests.get(key);
      clientRequests.delete(key);
      if (owner !== undefined && owner.context.ended === undefined && current === owner.context)
        yield* Queue.offer(owner.context.input, JSON.stringify({ ...message, id: owner.id }));
      return;
    }
    const isRequest = id !== undefined && id !== null && message?.method !== undefined;
    const context = current ?? predecessor;
    const latched = context?.terminal;
    const response = terminalSink(
      { answer: (answer, _status, reply) => options.output(answer, reply) },
      message,
      () => latched?.reason,
      () => false,
    );
    if (
      isRequest &&
      typeof id === "string" &&
      (id.startsWith(OWN_ID) || id.startsWith("goat-proxy:"))
    )
      return yield* response.answer(
        reservedIdAnswer(id, id.startsWith(OWN_ID) ? OWN_ID : "goat-proxy:"),
      );
    const key = JSON.stringify(id);
    if (isRequest && (owners.has(key) || setup.pending(key)))
      return yield* response.answer(refusal(id, message.method, "invalid_target", REQUEST_ID_BUSY));
    if (message?.method === "initialize" || message?.method === "notifications/initialized")
      handshake.push(line);
    if (context === undefined || current !== context || !context.ready || terminal !== undefined) {
      if (!isRequest) return;
      if (terminal === undefined) {
        const cached = setup.answerCached(id, message.method);
        if (cached !== undefined) return yield* cached;
      }
      const refuse = answerStopped(id, message.method, undefined, context);
      return yield* setup.covers(message.method)
        ? setup.answer(id, message.method, line, refuse).pipe(Effect.forkIn(scope))
        : refuse;
    }
    if (isRequest)
      owners.set(key, {
        context,
        latch: context.terminal,
        message,
        id,
        method: message.method,
        cancelled: false,
      });
    yield* Queue.offer(context.input, line);
  });
  yield* options.input.pipe(Stream.runForEach(handle));
  yield* finish("lost");
});
