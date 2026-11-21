import type { ChannelRequester, ChannelTask, MemoryTaskGrantCeiling } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { captureMemoryGrantCeiling, MEMORY_GRANT_RANK } from "../memory/MemoryAccess.ts";

import * as ChannelLedger from "./ChannelLedger.ts";
import { lowerRuntimeMode } from "./ChannelGateway.ts";
import { currentChannelIdentity } from "./channelCurrentIdentity.ts";

/** A run's memory for this task: its recorded ceiling, lowered to the requester's scopes now. */
export const sessionMemoryCeiling = (
  requester: ChannelRequester,
  target: ChannelTask["target"],
): MemoryTaskGrantCeiling => {
  const allowed = captureMemoryGrantCeiling(requester.grantedScopes, false);
  const recorded = target?.memoryGrantCeiling ?? "none";
  return MEMORY_GRANT_RANK[allowed] < MEMORY_GRANT_RANK[recorded] ? allowed : recorded;
};

export const makeDispatchConfirmation = Effect.fn("channel.makeDispatchConfirmation")(function* (
  required: boolean,
  allowed: Effect.Effect<boolean, ChannelLedger.ChannelLedgerError>,
) {
  const refused = yield* Ref.make(false);
  return {
    options: required
      ? {
          confirm: allowed.pipe(
            Effect.orElseSucceed(() => false),
            Effect.tap((allowed) => (allowed ? Effect.void : Ref.set(refused, true))),
          ),
        }
      : {},
    refused: Ref.get(refused),
  };
});

export const narrowRequester = (
  snapshot: ChannelRequester,
  current: ChannelLedger.ChannelIdentity | undefined,
) => {
  if (current?.ownerId !== snapshot.ownerId || current.principalId !== snapshot.principalId)
    return undefined;
  return {
    ...snapshot,
    grantedScopes: snapshot.grantedScopes.filter((scope) => current.grantedScopes.includes(scope)),
    runtimeModeCeiling: lowerRuntimeMode(snapshot.runtimeModeCeiling, current.runtimeModeCeiling),
  };
};

/**
 * A linked account as it stands now on its own connection: scopes narrowed to its link and the
 * lower runtime mode; undefined once the link is gone or now belongs to someone else.
 */
export const currentRequester = Effect.fn("channel.currentRequester")(function* (
  snapshot: ChannelRequester,
  connectionId: string | undefined,
) {
  if (snapshot.originKind !== "slack" && snapshot.originKind !== "imessage") return snapshot;
  if (snapshot.externalActorId === undefined || connectionId === undefined) return undefined;
  const current = yield* currentChannelIdentity({
    connectionId,
    externalActorId: snapshot.externalActorId,
  });
  return narrowRequester(snapshot, current);
});

/** Intake is a snapshot; a queued task cannot keep a revoked or reassigned external grant. */
export const requesterForDispatch = Effect.fn("channel.requesterForDispatch")(function* (
  task: ChannelTask,
) {
  if (task.routineWork === true) {
    const ledger = yield* ChannelLedger.ChannelLedger;
    const grant = yield* ledger.routineWorkAuthority(task.originInputId);
    if (
      "error" in grant ||
      grant.projectId !== task.projectId ||
      (task.target !== undefined &&
        (task.target.projectId !== task.projectId || task.target.remote !== undefined))
    )
      return undefined;
    return {
      ...task.requester,
      grantedScopes: grant.scopes,
      runtimeModeCeiling: "approval-required" as const,
    };
  }
  const address = task.originAddress;
  const requester =
    address.kind === "slack" || address.kind === "imessage"
      ? yield* currentRequester(task.requester, address.connectionId)
      : task.requester;
  if (requester === undefined) return undefined;
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

/** Reapply the current requester grant without widening a worker's recorded memory ceiling. */
export const workerMemoryCeiling = Effect.fn("channel.workerMemoryCeiling")(function* (
  task: ChannelTask,
) {
  if (task.routineWork === true) return "none" as const;
  const requester = yield* currentRequester(
    task.requester,
    task.originAddress.kind === "slack" || task.originAddress.kind === "imessage"
      ? task.originAddress.connectionId
      : undefined,
  );
  if (requester === undefined) return "none" as const;
  return task.target === undefined
    ? captureMemoryGrantCeiling(requester.grantedScopes, false)
    : sessionMemoryCeiling(requester, task.target);
});
