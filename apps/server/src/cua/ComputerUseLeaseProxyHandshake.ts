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
/** As long as a client waits for an MCP server to start before giving up on it. */
const ANSWER_WITHIN = "10 seconds";

export const makeLeaseProxyHandshake = <E>(options: {
  readonly startDriver: Effect.Effect<LeaseProxyDriver, E, Scope.Scope>;
  /** The provider's handshake lines so far, in order. */
  readonly handshake: ReadonlyArray<string>;
  readonly ownId: (kind: string) => string;
  readonly output: (line: string) => Effect.Effect<void>;
}) => {
  const answers = new Map<string, unknown>();
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

  return {
    covers: (method: string | undefined) => method !== undefined && HANDSHAKE.has(method),
    /** Keeps a child's answer to a handshake request, to answer it again while paused. */
    remember: (method: string, message: Envelope) => {
      if (method !== "ping" && HANDSHAKE.has(method) && message.result !== undefined)
        answers.set(method, message.result);
    },
    /**
     * Answers a handshake request without the control's driver, or runs the refusal when no
     * child could answer it in time.
     */
    answer: Effect.fn("ComputerUseLeaseProxy.answerHandshake")(function* (
      id: JsonRpcId,
      method: string,
      line: string | undefined,
      refuse: Effect.Effect<void>,
    ) {
      if (method === "ping") return yield* reply(id, {});
      if (answers.has(method)) return yield* reply(id, answers.get(method));
      // A request a pause cut off is asked again as the provider sent it.
      const request =
        line ??
        options.handshake.find((entry) => parse(entry)?.id === id) ??
        JSON.stringify({ jsonrpc: "2.0", id, method, params: {} });
      const answer = yield* ask(
        method === "initialize" ? [request] : [...options.handshake, request],
      );
      if (answer?.result === undefined) return yield* refuse;
      answers.set(method, answer.result);
      yield* reply(id, answer.result);
    }),
  };
};
