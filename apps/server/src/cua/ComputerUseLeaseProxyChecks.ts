// @effect-diagnostics preferSchemaOverJson:off -- Driver JSON-RPC requests remain opaque.
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Scheduler from "effect/Scheduler";
import type { Envelope } from "./ComputerUseLeaseProtocol.ts";
import { proveProxyDisplay, refuseProxyCall } from "./ComputerUseLeaseProxyRefusal.ts";
import type { LeaseEnd } from "./ComputerUseLeaseMessages.ts";
import type { JsonRpcId } from "./ComputerUseLeaseResponses.ts";
import type { Running } from "./ComputerUseLeaseProxyLifecycle.ts";

export const makeProxyChecks = (input: {
  readonly current: () => Running | undefined;
  readonly ownAnswers: Map<string, Deferred.Deferred<Envelope | undefined>>;
  readonly ended: Deferred.Deferred<LeaseEnd>;
  readonly nextId: (kind: "apps" | "windows") => string;
  readonly proof: Omit<
    Parameters<typeof proveProxyDisplay>[0],
    "current" | "ownAnswers" | "ended" | "nextId"
  >;
  readonly refusal: (
    id: JsonRpcId,
    message: Envelope,
    listApps: Effect.Effect<void>,
  ) => Parameters<typeof refuseProxyCall>[0];
  readonly expire: Effect.Effect<void>;
  readonly deadline: () => number;
}) => {
  const listApps = Effect.fn("ComputerUseLeaseProxy.listApps")(function* (
    canSend: Effect.Effect<boolean>,
  ) {
    const current = input.current();
    if (current === undefined) return;
    const id = input.nextId("apps");
    const answered = yield* Deferred.make<Envelope | undefined>();
    input.ownAnswers.set(id, answered);
    const sent = yield* Effect.gen(function* () {
      if (!(yield* canSend)) return false;
      yield* current.driver.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name: "list_apps", arguments: {} },
        }),
      );
      return true;
    }).pipe(Effect.provideService(Scheduler.PreventSchedulerYield, true));
    if (!sent) {
      input.ownAnswers.delete(id);
      return;
    }
    yield* Effect.raceFirst(
      Deferred.await(answered),
      Deferred.await(input.ended).pipe(Effect.asVoid),
    );
  });
  const proveDisplay = (canSend: Effect.Effect<boolean>) =>
    proveProxyDisplay({
      ...input.proof,
      current: input.current,
      ownAnswers: input.ownAnswers,
      ended: input.ended,
      nextId: () => input.nextId("windows"),
      canSend,
    });
  const refuseCall = Effect.fn("ComputerUseLeaseProxy.checkCall")(function* (
    id: JsonRpcId,
    message: Envelope,
    canSend: Effect.Effect<boolean>,
  ) {
    if (
      input.proof.finished() === undefined &&
      (yield* Clock.currentTimeMillis) >= input.deadline()
    )
      yield* input.expire;
    return yield* refuseProxyCall(input.refusal(id, message, listApps(canSend)));
  });
  return { listApps, proveDisplay, refuseCall };
};
