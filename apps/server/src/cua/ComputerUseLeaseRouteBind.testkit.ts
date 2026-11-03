// @effect-diagnostics preferSchemaOverJson:off -- The fake driver exchanges opaque JSON-RPC lines.
import * as Effect from "effect/Effect";
import type { PendingBrowserBind } from "./ComputerUseClaimBindAuthority.ts";
import { active, CONTROL, type harness } from "./ComputerUseLeaseProxy.testkit.ts";

type Harness = Effect.Success<ReturnType<typeof harness>>;

export const sendApprovedBind = Effect.fn("LeaseRouteTest.sendApprovedBind")(function* (
  proxy: Harness,
  bindings: ReadonlyArray<PendingBrowserBind>,
  claimId: string,
) {
  yield* proxy.push({ ...active(), browserClaimBindings: bindings });
  yield* proxy.applied;
  const current = yield* proxy.driverStarted;
  yield* proxy.send(JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list", params: {} }));
  yield* proxy.nextToDriver;
  yield* proxy.reply(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 99,
      result: {
        tools: [{ name: "get_browser_state", inputSchema: { properties: { origin_scope: {} } } }],
      },
    }),
  );
  yield* proxy.nextToProvider;
  yield* proxy.sendPrimitive({
    state: "primitive-request",
    requestId: "request:bind",
    registrationId: "registration:one",
    controlId: CONTROL,
    connectionGeneration: current.connectionId,
    runId: "run:bind",
    turnId: "turn:bind",
    callId: 0,
    deadlineMillis: 60_000,
    tool: "get_browser_state",
    authority: "claimBind",
    args: {
      pid: 42,
      window_id: 7,
      origin_scope: ["https://example.test"],
      session: `goat-claim:${claimId}`,
    },
  });
});
