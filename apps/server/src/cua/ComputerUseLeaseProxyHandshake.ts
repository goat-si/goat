/**
 * Answers the provider's MCP handshake while the lease proxy has no driver child (#1604). A
 * pause (a private field, a takeover, the turn's end) stops the driver, but an MCP client that
 * cannot initialize a server, or list its tools, drops it for the whole session, so the agent
 * would lose computer use instead of hearing why its calls wait.
 *
 * A listing a child already gave is answered again from memory. Otherwise a short-lived child
 * answers it: that child hears only the provider's own handshake and this request, never a
 * tool call, and is killed as soon as it answers.
 *
 * @module ComputerUseLeaseProxyHandshake
 */
// JSON-RPC lines pass through unchanged; only the fields the proxy acts on are read.
// @effect-diagnostics preferSchemaOverJson:off
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { type Envelope, parse } from "./ComputerUseLeaseProtocol.ts";
import type { LeaseProxyDriver } from "./ComputerUseLeaseProxyOptions.ts";
import type { JsonRpcId } from "./ComputerUseLeaseResponses.ts";

/** Requests that set up the session or describe the driver; none of them acts on the screen. */
const HANDSHAKE = new Set(["initialize", "tools/list", "ping"]);
/** Well inside the time a client gives an MCP server to start (Codex 0.163.0 waits 30 s). */
const ANSWER_WITHIN = "10 seconds";

export const makeLeaseProxyHandshake = <E, End>(options: {
  readonly startDriver: Effect.Effect<LeaseProxyDriver, E, Scope.Scope>;
  /** The provider's handshake lines so far, in order. */
  readonly handshake: ReadonlyArray<string>;
  readonly ownId: (kind: string) => string;
  readonly output: (line: string) => Effect.Effect<void>;
  /** The proxy's own requests to its current child, by id, answered as its lines are read. */
  readonly ownAnswers: Map<string, Deferred.Deferred<Envelope | undefined>>;
  /** Done when the control ends; a handshake request is then refused with endAnswer. */
  readonly ended: Deferred.Deferred<End>;
  readonly endAnswer: (id: JsonRpcId, method: string, reason: End) => string;
}) => {
  const whenEnded = (id: JsonRpcId, method: string) =>
    Deferred.await(options.ended).pipe(
      Effect.flatMap((reason) => options.output(options.endAnswer(id, method, reason))),
    );
  /**
   * Tool lists a live child gave (a resumed child's answer or a recheck). A borrowed list that
   * began before one of these is older and is not kept; borrowed lists never outrank each other.
   */
  let listings = 0;
  const answers = new Map<string, unknown>();
  /** The provider holds a tool list this module gave it, which the next child must confirm. */
  let served = false;
  /** Handshake requests a child is answering, by request key, which the provider may cancel. */
  const cancels = new Map<string, Deferred.Deferred<void>>();
  const reply = (id: JsonRpcId, result: unknown) =>
    options.output(JSON.stringify({ jsonrpc: "2.0", id, result }));

  /** Sends each request to a fresh child in turn and returns its answer to the last one. */
  const ask = Effect.fn("ComputerUseLeaseProxy.askHandshakeChild")(function* (
    lines: ReadonlyArray<string>,
  ) {
    const scope = yield* Scope.make();
    let driver: LeaseProxyDriver | undefined;
    return yield* Effect.gen(function* () {
      const child = yield* options.startDriver.pipe(Scope.provide(scope));
      driver = child;
      const waiting = new Map<string, Deferred.Deferred<Envelope>>();
      yield* child.lines.pipe(
        Stream.runForEach((line) => {
          const message = parse(line);
          const waiter =
            message?.method === undefined && typeof message?.id === "string"
              ? waiting.get(message.id)
              : undefined;
          return waiter === undefined || message === undefined
            ? Effect.void
            : Deferred.succeed(waiter, message);
        }),
        Effect.forkIn(scope),
      );
      let last: Envelope | undefined;
      for (const line of lines) {
        const message = parse(line);
        if (message?.id === undefined || message.id === null) {
          yield* child.send(line);
          continue;
        }
        const id = options.ownId("handshake");
        const answered = yield* Deferred.make<Envelope>();
        waiting.set(id, answered);
        yield* child.send(JSON.stringify({ ...message, id }));
        last = yield* Deferred.await(answered);
      }
      return last;
    }).pipe(
      Effect.timeoutOption(ANSWER_WITHIN),
      Effect.map(Option.getOrUndefined),
      Effect.catchCause(() => Effect.succeed(undefined)),
      Effect.ensuring(
        Effect.suspend(() => driver?.kill ?? Effect.void).pipe(
          Effect.andThen(Scope.close(scope, Exit.void)),
        ),
      ),
    );
  });

  const respond = Effect.fn("ComputerUseLeaseProxy.respondToHandshake")(function* (
    id: JsonRpcId,
    method: string,
    line: string | undefined,
    refuse: Effect.Effect<void>,
  ) {
    // An end that is already done wins over a remembered answer (#1622).
    if (Deferred.isDoneUnsafe(options.ended)) return yield* whenEnded(id, method);
    if (method === "ping") return yield* reply(id, {});
    if (method === "tools/list") served = true;
    if (answers.has(method)) return yield* reply(id, answers.get(method));
    const listed = listings;
    // A request a pause cut off is asked again as the provider sent it.
    const request =
      line ??
      options.handshake.find((entry) => parse(entry)?.id === id) ??
      JSON.stringify({ jsonrpc: "2.0", id, method, params: {} });
    const answer = yield* ask(
      method === "initialize" ? [request] : [...options.handshake, request],
    );
    if (answer?.result === undefined) return yield* refuse;
    if (Deferred.isDoneUnsafe(options.ended)) return yield* whenEnded(id, method);
    // A newer list, from a resumed child, came in while this child answered: it stands.
    if (method !== "tools/list" || listed === listings) answers.set(method, answer.result);
    yield* reply(id, answers.get(method) ?? answer.result);
  });

  return {
    covers: (method: string | undefined) => method !== undefined && HANDSHAKE.has(method),
    /** Keeps a child's answer to a handshake request, to answer it again while paused. */
    remember: (method: string, message: Envelope) => {
      if (method === "ping" || !HANDSHAKE.has(method) || message.result === undefined) return;
      answers.set(method, message.result);
      if (method === "tools/list") {
        served = false;
        listings++;
      }
    },
    /**
     * Answers a handshake request without the control's driver, or runs the refusal when no
     * child could answer it in time. An end or the provider's cancellation stops the child it
     * started, and an end answers the request as ended instead.
     */
    answer: (
      id: JsonRpcId,
      method: string,
      line: string | undefined,
      refuse: Effect.Effect<void>,
    ) => {
      // Registered before the answer runs, so a cancel that comes first still stops it, and a
      // repeated id is seen as pending (#1622).
      const key = JSON.stringify(id);
      const cancelled = Deferred.makeUnsafe<void>();
      cancels.set(key, cancelled);
      return Effect.suspend(() =>
        Deferred.isDoneUnsafe(cancelled)
          ? Effect.void
          : Effect.raceAll([
              respond(id, method, line, refuse),
              whenEnded(id, method),
              Deferred.await(cancelled),
            ]),
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (cancels.get(key) === cancelled) cancels.delete(key);
          }),
        ),
        Effect.withSpan("ComputerUseLeaseProxy.answerHandshake"),
      );
    },
    pending: (key: string) => cancels.has(key),
    cancel: (key: string) => {
      const cancelled = cancels.get(key);
      if (cancelled !== undefined) Deferred.doneUnsafe(cancelled, Exit.void);
    },
    /**
     * Asks a new child for its tools after the provider was given a remembered or borrowed list,
     * and tells the provider to list again when they differ, as after a driver update.
     */
    recheck: Effect.fn("ComputerUseLeaseProxy.recheckTools")(function* (
      send: (line: string) => Effect.Effect<void>,
    ) {
      if (!served) return;
      const id = options.ownId("tools");
      const answered = yield* Deferred.make<Envelope | undefined>();
      options.ownAnswers.set(id, answered);
      yield* send(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list", params: {} }));
      const answer = yield* Deferred.await(answered);
      if (answer?.result === undefined) return;
      served = false;
      listings++;
      const before = JSON.stringify(answers.get("tools/list"));
      answers.set("tools/list", answer.result);
      if (JSON.stringify(answer.result) !== before)
        yield* options.output(
          JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }),
        );
    }),
  };
};
