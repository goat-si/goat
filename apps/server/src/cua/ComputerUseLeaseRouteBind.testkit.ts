// @effect-diagnostics preferSchemaOverJson:off -- The fake driver exchanges opaque JSON-RPC lines.
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Option from "effect/Option";
import { assert } from "@effect/vitest";
import { ComputerUseCallAdmission, type ComputerUseCallReservation } from "@goat/contracts";
import * as Schema from "effect/Schema";
import type { PendingBrowserBind } from "./ComputerUseClaimBindAuthority.ts";
import { active, CONTROL, type harness } from "./ComputerUseLeaseProxy.testkit.ts";

type Harness = Effect.Success<ReturnType<typeof harness>>;
const decodeAdmission = Schema.decodeUnknownSync(ComputerUseCallAdmission);

export const reservationViaRoute =
  (
    reserve: (name: string, args: unknown, authority?: "claimBind") => Effect.Effect<unknown>,
    observe: (value: unknown) => void,
  ) =>
  (request: ComputerUseCallReservation) =>
    request.action === "reserve"
      ? reserve(request.name, request.args, request.authority).pipe(
          Effect.tap((value) => Effect.sync(() => observe(value))),
          Effect.map(decodeAdmission),
        )
      : Effect.succeed({ status: "released" as const });

export const claimBindArgs = (claimId: string) => ({
  pid: 42,
  window_id: 7,
  origin_scope: ["https://example.test"],
  session: `goat-claim:${claimId}`,
});

export const startUntrustedBind = Effect.fn("LeaseRouteTest.startUntrustedBind")(function* (
  request: Effect.Effect<unknown>,
  reservationStarted: Deferred.Deferred<void>,
) {
  const fiber = yield* request.pipe(Effect.forkChild({ startImmediately: true }));
  assert.isTrue(Option.isNone(yield* Deferred.poll(reservationStarted)));
  return fiber;
});

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
    args: claimBindArgs(claimId),
  });
});
