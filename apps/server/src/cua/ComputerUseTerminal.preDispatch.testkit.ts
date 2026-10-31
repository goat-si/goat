import { assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { parse } from "./ComputerUseLeaseProtocol.ts";
import { makeProxyCallScope } from "./ComputerUseLeaseProxyPointBasis.ts";
import { finalTerminalLine } from "./ComputerUseLeaseProxyPersonStop.ts";
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

export const preDispatchSites = [
  { name: "ComputerUseLeaseProxyBatch.scope", undispatched: true, run: unsupported("batch") },
  { name: "ComputerUseLeaseProxyPointBasis.check", undispatched: true, run: unsupported("point") },
];
