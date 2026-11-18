// @effect-diagnostics-next-line nodeBuiltinImport:off -- server-owned checkpoint identifiers.
import * as NodeCrypto from "node:crypto";
import * as M from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type { MemoryStore } from "./MemoryStore.ts";

export const prepareJoinRetention = Effect.fn("MemoryHubService.prepareJoinRetention")(function* (
  store: MemoryStore["Service"],
  principal: M.MemoryHubPrincipal,
  hubEnvironmentId: M.EnvironmentId,
) {
  const memorySpaceId = principal.memorySpaceId;
  const retention = yield* store.readHubRetentionTx(memorySpaceId);
  if (retention.checkpointId !== null || retention.causalBoundary === null) return retention;
  const owner = yield* store.readHubMember(memorySpaceId, hubEnvironmentId);
  if (owner?.status !== "active")
    return yield* new M.MemoryHubError({ code: "bootstrap_required" });
  const hubPrincipal = {
    ...principal,
    environmentId: hubEnvironmentId,
    credentialVersion: owner.credentialVersion,
  };
  const checkpointId = NodeCrypto.randomUUID();
  yield* store.prepareHubProducerCheckpointTx({
    authority: {
      principal: hubPrincipal,
      now: Clock.currentTimeMillis,
      reauthorize: Effect.asVoid(store.requireHubMemberTx(principal)),
    },
    checkpointId,
    hubEnvironmentId,
  });
  return yield* store.publishCheckpointAndFloorTx({
    memorySpaceId,
    checkpointId,
    expectedFloor: retention.retentionFloor,
    nextFloor: retention.retentionFloor,
    now: yield* Clock.currentTimeMillis,
  });
});
