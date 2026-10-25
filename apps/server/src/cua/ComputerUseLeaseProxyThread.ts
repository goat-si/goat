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
  "onTarget" | "onHumanInput" | "onAgentInput"
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
const WAITING = "Computer use is not available for this turn. A new approval or turn restores it.";

interface Context {
  readonly controlId: string;
  readonly input: Queue.Queue<string, Cause.Done>;
  readonly updates: Queue.Queue<ComputerUseLeaseUpdate, Cause.Done>;
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
      refusal(id, method, reason, terminal === undefined ? WAITING : LEASE_END_MESSAGES[reason]),
    );

  const output = (context: Context, line: string) =>
    Effect.suspend(() => {
      const message = parse(line);
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
      return options.output(line);
    });

  const stop = Effect.fn("ComputerUseLeaseProxyThread.stopControl")(function* (
    context: Context,
    reason: ComputerUseControlEnd | "lost",
  ) {
    if (context.ended !== undefined) return;
    context.ended = reason;
    if (current === context) current = undefined;
    waiting = reason;
    if (reason === "lost") yield* Queue.end(context.updates);
    else yield* Queue.offer(context.updates, { state: "ended", reason });
  });

  const finish = Effect.fn("ComputerUseLeaseProxyThread.finish")(function* (
    reason: ComputerUseControlEnd | "lost",
  ) {
    if (terminal !== undefined) return;
    terminal = reason;
    yield* Deferred.succeed(ended, reason);
    if (current !== undefined) yield* stop(current, reason);
  });

  const select = Effect.fn("ComputerUseLeaseProxyThread.selectControl")(function* (
    update: Extract<ComputerUseLeaseThreadUpdate, { state: "active" | "paused" | "idle" }>,
  ) {
    const expiresAt = DateTime.make(update.expiresAt);
    if (Option.isNone(expiresAt)) return yield* finish("lost");
    if (current?.controlId === update.controlId) {
      current.deadline = Math.min(current.deadline, DateTime.toEpochMillis(expiresAt.value));
      yield* Queue.offer(current.wake, undefined);
      yield* Queue.offer(current.updates, update);
      return;
    }
    if (current !== undefined) yield* stop(current, "replaced");
    // A stopped/expired id cannot be revived by a delayed snapshot from the subscription.
    if (seen.has(update.controlId)) return;
    seen.add(update.controlId);
    const previous = predecessor;
    const context: Context = {
      controlId: update.controlId,
      input: yield* Queue.unbounded<string, Cause.Done>(),
      updates: yield* Queue.unbounded<ComputerUseLeaseUpdate, Cause.Done>(),
      closed: yield* Deferred.make<void>(),
      replayIds: new Set(),
      wake: yield* Queue.sliding<void>(1),
      deadline: DateTime.toEpochMillis(expiresAt.value),
    };
    const connectionId = `${options.connectionId}:control:${sequence++}`;
    const reports = options.reports(context.controlId);
    // Seed before accepting live messages; the replay belongs only to this instance.
    for (const line of handshake) {
      const message = parse(line);
      if (message?.method === "initialize") {
        const id = `${OWN_ID}initialize:${sequence++}`;
        context.replayIds.add(JSON.stringify(id));
        yield* Queue.offer(context.input, JSON.stringify({ ...message, id }));
      } else yield* Queue.offer(context.input, line);
    }
    yield* Queue.offer(context.updates, update);
    current = context;
    predecessor = context;
    // The supervisor stops routing at local expiry too; the legacy proxy keeps its own guard.
    yield* Effect.raceFirst(
      watchLeaseProxyDeadlines({
        wake: context.wake,
        controlDeadline: () => context.deadline,
        foregroundDeadline: () => Infinity,
        expireControl: stop(context, "expired"),
        expireForeground: () => Effect.void,
      }),
      Deferred.await(context.closed),
    ).pipe(Effect.forkIn(scope));
    yield* Effect.gen(function* () {
      const controlScope = yield* Effect.scope;
      if (previous !== undefined) yield* Deferred.await(previous.closed);
      if (context.ended !== undefined || terminal !== undefined) return;
      let rechecked = false;
      const reason = yield* runLeaseProxy({
        ...options,
        ...reports,
        connectionId,
        controlId: context.controlId,
        expiresAt: expiresAt.value,
        input: Stream.fromQueue(context.input),
        output: (line) => output(context, line),
        leaseUpdates: Stream.fromQueue(context.updates),
        onLeaseUpdateApplied: Effect.fn("ComputerUseLeaseProxyThread.appliedUpdate")(
          function* (applied) {
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

  const take = Effect.fn("ComputerUseLeaseProxyThread.takeUpdate")(function* (
    update: ComputerUseLeaseThreadUpdate,
  ) {
    if (terminal === undefined) {
      if (update.state === "ended") yield* finish(update.reason);
      else if (update.state === "control-ended") {
        seen.add(update.controlId);
        if (current?.controlId === update.controlId) yield* stop(current, update.reason);
      } else if (update.state === "waiting") {
        if (current !== undefined) yield* stop(current, "replaced");
      } else yield* select(update);
    }
    yield* options.onThreadUpdate?.(update) ?? Effect.void;
  });
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
    if (context === undefined || terminal !== undefined) {
      if (!isRequest) return;
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
