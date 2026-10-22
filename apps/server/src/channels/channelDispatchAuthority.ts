import type { ChannelTask } from "@goat/contracts";
import * as Effect from "effect/Effect";
import { captureMemoryGrantCeiling } from "../memory/MemoryAccess.ts";

import { lowerRuntimeMode } from "./ChannelGateway.ts";
import * as ChannelLedger from "./ChannelLedger.ts";

/** Intake is a snapshot; a queued task cannot keep a revoked or reassigned external grant. */
export const requesterForDispatch = Effect.fn("channel.requesterForDispatch")(function* (
  task: ChannelTask,
) {
  let requester = task.requester;
  const address = task.originAddress;
  if (address.kind === "slack" || address.kind === "imessage") {
    if (requester.externalActorId === undefined) return undefined;
    const ledger = yield* ChannelLedger.ChannelLedger;
    const current = yield* ledger.findIdentity({
      connectionId: address.connectionId,
      externalActorId: requester.externalActorId,
    });
    if (
      current === undefined ||
      current.ownerId !== requester.ownerId ||
      current.principalId !== requester.principalId
    )
      return undefined;
    requester = {
      ...requester,
      grantedScopes: requester.grantedScopes.filter((scope) =>
        current.grantedScopes.includes(scope),
      ),
      runtimeModeCeiling: lowerRuntimeMode(
        requester.runtimeModeCeiling,
        current.runtimeModeCeiling,
      ),
    };
  }
  if (!requester.grantedScopes.includes("orchestration:operate")) return undefined;
  const target = task.target;
  if (task.status !== "received" && target?.remote !== undefined) {
    const recorded = target.remote.automatic?.runtimeModeCeiling;
    if (
      target.remote.automatic !== undefined &&
      (recorded === undefined ||
        lowerRuntimeMode(recorded, requester.runtimeModeCeiling) !== recorded)
    )
      return undefined;
    const memory = captureMemoryGrantCeiling(requester.grantedScopes, false);
    if (target.memoryGrantCeiling === "read_write" && memory !== "read_write") return undefined;
    if (target.memoryGrantCeiling === "read" && memory === "none") return undefined;
  }
  if (
    (task.status === "dispatching" ||
      (task.status !== "received" && target?.remote !== undefined)) &&
    target !== undefined
  ) {
    if (lowerRuntimeMode(target.runtimeMode, requester.runtimeModeCeiling) !== target.runtimeMode)
      return undefined;
  }
  return requester;
});
