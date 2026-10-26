/** One MCP transport, with an isolated legacy proxy and reservation generation per control. */
// @effect-diagnostics preferSchemaOverJson:off -- MCP envelopes retain the client's opaque fields.
import type {
  ComputerUseControlEnd,
  ComputerUseLeaseThreadUpdate,
  ComputerUseLeaseUpdate,
} from "@goat/contracts";
import type * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { cancelledRequestKey } from "./ComputerUseDriverReply.ts";
import { type Envelope, parse } from "./ComputerUseLeaseProtocol.ts";
import { type LeaseEnd, LEASE_END_MESSAGES } from "./ComputerUseLeaseMessages.ts";
import { watchLeaseProxyDeadlines } from "./ComputerUseLeaseProxyDeadline.ts";
import { runLeaseProxy } from "./ComputerUseLeaseProxy.ts";
import { makeLeaseProxyHandshake } from "./ComputerUseLeaseProxyHandshake.ts";
import type { LeaseProxyOptions } from "./ComputerUseLeaseProxyOptions.ts";
import { type JsonRpcId, refusal, reservedIdAnswer } from "./ComputerUseLeaseResponses.ts";

type Reports<EU, ED> = Pick<
  LeaseProxyOptions<EU, ED>,
  "onTarget" | "onCursor" | "onHumanInput" | "onAgentInput"
>;
type ThreadProxyOptions<EU, ED> = Omit<
  LeaseProxyOptions<EU, ED>,
  "controlId" | "expiresAt" | "leaseUpdates" | keyof Reports<EU, ED>
> & {
  readonly leaseUpdates: Stream.Stream<ComputerUseLeaseThreadUpdate, EU>;
  /** Captured once, so even delayed reports belong to the control that produced them. */
  readonly reports: (controlId: string) => Reports<EU, ED>;
  /** Runs after the supervisor has routed an update, without waiting for native teardown. */
  readonly onThreadUpdate?: (update: ComputerUseLeaseThreadUpdate) => Effect.Effect<void>;
};

const OWN_ID = "goat-thread-proxy:";
const WAITING = "Computer use is not available for this turn.";

interface Context {
  readonly controlId: string;
  readonly input: Queue.Queue<string, Cause.Done>;
  readonly updates: Array<ComputerUseLeaseUpdate | undefined>;
  receive?: (update: ComputerUseLeaseUpdate | undefined) => void;
  ready: boolean;
  readonly closed: Deferred.Deferred<void>;
  readonly replayIds: Set<string>;
  readonly wake: Queue.Queue<void>;
  deadline: number;
  ended?: LeaseEnd;
}

export const runThreadLeaseProxy = Effect.fn("ComputerUseLeaseProxyThread.run")(function* <EU, ED>(
  options: ThreadProxyOptions<EU, ED>,
) {
  const scope = yield* Effect.scope;
  let current: Context | undefined;
  let predecessor: Context | undefined;
  let terminal: LeaseEnd | undefined;
  let waiting: LeaseEnd = "stopped";
  let sequence = 0;
  const seen = new Set<string>();
  const handshake: Array<string> = [];
  const ended = yield* Deferred.make<LeaseEnd>();
  const owners = new Map<
    string,
    { context: Context; id: JsonRpcId; method: string; cancelled: boolean }
  >();
  const clientRequests = new Map<string, { context: Context; id: JsonRpcId }>();
  const ownAnswers = new Map<string, Deferred.Deferred<Envelope | undefined>>();
  const setup = makeLeaseProxyHandshake({
    startDriver: options.startHandshakeDriver ?? options.startDriver,
    handshake,
    ownId: (kind) => `${OWN_ID}${kind}:${sequence++}`,
    output: options.output,
    ownAnswers,
    ended,
    endAnswer: (id, method, reason) => refusal(id, method, reason, LEASE_END_MESSAGES[reason]),
  });
  const answerStopped = (id: JsonRpcId, method: string | undefined, reason = terminal ?? waiting) =>
    options.output(
      refusal(
        id,
        method,
        reason,
        terminal !== undefined
          ? LEASE_END_MESSAGES[reason]
          : reason === "disabled"
            ? "Computer use is turned off in settings. Re-enable it, then start a new turn or approval."
            : WAITING,
      ),
    );

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
        owners.delete(key);
        if (owner.cancelled) return Effect.void;
        setup.remember(owner.method, message);
      }
      return options.output(line, reply);
    });

  const receive = (context: Context, update: ComputerUseLeaseUpdate | undefined) => {
    if (context.receive === undefined) context.updates.push(update);
    else context.receive(update);
  };
  // Receipt and routing must change in one synchronous step, before any Effect can yield.
  const stop = (context: Context, reason: ComputerUseControlEnd | "lost") => {
    if (context.ended !== undefined) return;
    context.ended = reason;
    context.ready = false;
    if (current === context) current = undefined;
    waiting = reason;
    for (const [key, owner] of clientRequests)
      if (owner.context === context) clientRequests.delete(key);
    receive(context, reason === "lost" ? undefined : { state: "ended", reason });
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
      current.deadline = Math.min(current.deadline, DateTime.toEpochMillis(expiresAt.value));
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
      updates: [],
      ready: false,
      closed: yield* Deferred.make<void>(),
      replayIds: new Set(),
      wake: yield* Queue.sliding<void>(1),
      deadline: DateTime.toEpochMillis(expiresAt.value),
    };
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
        input: Stream.fromQueue(context.input),
        output: (line, reply) => output(context, line, reply),
        leaseUpdates: Stream.never,
        onLeaseUpdateReceiver: (take) => {
          context.receive = take;
          for (const update of context.updates) take(update);
          context.updates.length = 0;
        },
        onCancelledRequestSettled: (key) => {
          if (owners.get(key)?.context === context) owners.delete(key);
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
            owners.delete(key);
            if (!owner.cancelled)
              yield* answerStopped(owner.id, owner.method, context.ended ?? terminal ?? "lost");
          }
          yield* Deferred.succeed(context.closed, undefined);
        }),
      ),
      Effect.forkIn(scope),
    );
  });

  const take = Effect.fn("ComputerUseLeaseProxyThread.takeUpdate")(
    (update: ComputerUseLeaseThreadUpdate) =>
      Effect.suspend(() => {
        if (terminal === undefined) {
          if (update.state === "ended") finishNow(update.reason);
          else if (update.state === "control-ended") {
            seen.add(update.controlId);
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

  const handle = Effect.fn("ComputerUseLeaseProxyThread.routeMessage")(function* (line: string) {
    const message = parse(line);
    if (message?.method === "$/cancelRequest") {
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
    if (
      isRequest &&
      typeof id === "string" &&
      (id.startsWith(OWN_ID) || id.startsWith("goat-proxy:"))
    )
      return yield* options.output(
        reservedIdAnswer(id, id.startsWith(OWN_ID) ? OWN_ID : "goat-proxy:"),
      );
    const key = JSON.stringify(id);
    if (isRequest && (owners.has(key) || setup.pending(key)))
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
    const context = current;
    if (context === undefined || !context.ready || terminal !== undefined) {
      if (!isRequest) return;
      if (terminal === undefined) {
        const cached = setup.answerCached(id, message.method);
        if (cached !== undefined) return yield* cached;
      }
      const refuse = answerStopped(id, message.method);
      return yield* setup.covers(message.method)
        ? setup.answer(id, message.method, line, refuse).pipe(Effect.forkIn(scope))
        : refuse;
    }
    if (isRequest) owners.set(key, { context, id, method: message.method, cancelled: false });
    yield* Queue.offer(context.input, line);
  });
  yield* options.input.pipe(Stream.runForEach(handle));
  yield* finish("lost");
});
