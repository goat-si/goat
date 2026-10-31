import { assert } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type { ComputerUsePrimitiveReply, ComputerUsePrimitiveRequest } from "@goat/contracts";
import { parse } from "./ComputerUseLeaseProtocol.ts";
import { makeProxyCallScope } from "./ComputerUseLeaseProxyPointBasis.ts";
import { finalTerminalLine, terminalSink } from "./ComputerUseLeaseProxyPersonStop.ts";
import { forwardPrimitiveRequests } from "./ComputerUseLeaseProxyOptions.ts";
import {
  replaceWithTerminal,
  terminalReplyState,
  type ComputerUseTerminalReason,
} from "./ComputerUseTerminal.ts";

type Input = { readonly possible: boolean; readonly reasons: readonly ComputerUseTerminalReason[] };

const unsupported = (kind: "batch" | "point") => (input: Input) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const child = {
      driver: { send: () => Effect.void, lines: Stream.empty, kill: Effect.void },
      scope,
      connectionId: "fixture",
      generation: 1,
    };
    const proxy = makeProxyCallScope(
      { listTools: () => Effect.succeed({ tools: [] }), remember: () => {} },
      () => child,
    );
    const name = kind === "batch" ? "run_steps" : "click";
    const args =
      kind === "batch" ? { app_scope: { apps: ["app"] }, steps: [] } : { snapshot_id: "s" };
    const line = JSON.stringify({ id: 1, method: "tools/call", params: { name, arguments: args } });
    const message = parse(line);
    if (message === undefined) return yield* Effect.die("invalid fixture message");
    const answer = yield* proxy.scope(1, line, message, () => "unexpected not-sent answer");
    if (!("refused" in answer)) return yield* Effect.die("expected scope refusal");
    assert.include(answer.refused, kind === "batch" ? "app_scope" : "screenshot");
    const final = finalTerminalLine(
      answer.refused,
      "not_started",
      { id: 1, method: "tools/call", params: { name: "list_apps" } },
      replaceWithTerminal("none", ...input.reasons),
    );
    return replaceWithTerminal(terminalReplyState(parse(final.line)?.result, "not_started"));
  });

const deadline = (input: Input) =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    const answered = yield* Deferred.make<ComputerUsePrimitiveReply>();
    const request: ComputerUsePrimitiveRequest = {
      state: "primitive-request",
      requestId: "request",
      registrationId: "registration",
      controlId: "control",
      connectionGeneration: "connection",
      runId: "run",
      turnId: "turn",
      callId: 1,
      deadlineMillis: 1000,
      tool: "list_apps",
      args: {},
    };
    yield* forwardPrimitiveRequests(
      Stream.make(request),
      (reply) => Deferred.succeed(answered, reply),
      () => "1",
      () => Deferred.await(gate),
      undefined,
      (sink, id) =>
        terminalSink(
          sink,
          { id, method: "tools/call", params: { name: "list_apps" } },
          () => replaceWithTerminal("none", ...input.reasons).reason,
          () => false,
        ),
    );
    yield* TestClock.adjust(1000);
    const reply = yield* Deferred.await(answered);
    return replaceWithTerminal(terminalReplyState(reply.result, reply.status));
  });

export const preDispatchSites = [
  { name: "ComputerUseLeaseProxyOptions.queuedDeadline", undispatched: true, run: deadline },
  { name: "ComputerUseLeaseProxyBatch.scope", undispatched: true, run: unsupported("batch") },
  { name: "ComputerUseLeaseProxyPointBasis.check", undispatched: true, run: unsupported("point") },
];
