import type { ComputerUseForegroundGrant } from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { requiresForeground } from "./ComputerUseCallReservations.ts";
import { proxyCallAdmission } from "./ComputerUseLeaseCallPermissions.ts";
import type { LeaseProxyOptions } from "./ComputerUseLeaseProxyOptions.ts";
import type { Envelope } from "./ComputerUseLeaseProtocol.ts";
import type { JsonRpcId } from "./ComputerUseLeaseResponses.ts";
import type { ListedApp } from "./ComputerUseScope.ts";

export const reserveProxyCall = Effect.fn("ComputerUseLeaseProxy.reserveCall")(function* (
  options: Pick<LeaseProxyOptions<never, never>, "reservation" | "controlId" | "bundleIds">,
  input: {
    readonly id: JsonRpcId;
    readonly message: Envelope;
    readonly connectionId: string;
    readonly callId: string;
    readonly interruptions: number;
    readonly idleEpoch: number;
    readonly foreground: ReadonlyArray<ComputerUseForegroundGrant>;
    readonly listed: ReadonlyMap<number, ListedApp>;
  },
) {
  const name =
    typeof input.message.params?.name === "string" ? input.message.params.name : "unknown";
  const args = input.message.params?.arguments ?? {};
  const now = yield* Clock.currentTimeMillis;
  const selectedForeground = requiresForeground({ name, args })
    ? input.foreground.find((grant) => grant.expiresAtMillis > now)
    : undefined;
  const decision = yield* options.reservation({
    action: "reserve",
    controlId: options.controlId,
    connectionId: input.connectionId,
    callId: input.callId,
    interruptions: input.interruptions,
    idleEpoch: input.idleEpoch,
    ...(selectedForeground === undefined
      ? {}
      : { foregroundGrantId: selectedForeground.handoffId }),
    name,
    args,
  });
  const admission = proxyCallAdmission(
    input.id,
    input.message,
    decision,
    input.listed,
    options.bundleIds,
  );
  return {
    ...admission,
    selectedForeground,
    deadline: Math.min(admission.deadline, selectedForeground?.expiresAtMillis ?? Infinity),
  };
});
