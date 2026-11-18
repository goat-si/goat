import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import { stored } from "./StoreCodecs.ts";
import type { StoreKernel } from "./StoreKernel.ts";
import { Transaction } from "./StoreModel.ts";

const fullAdvertisement = JSON.stringify(M.MEMORY_FLOOR_2);

export const makeHubFloor = ({ sql }: Pick<StoreKernel, "sql">) => {
  const blockingMembers = Effect.fn("MemoryStore.hubFloorBlockingMembers")(function* (
    space: M.MemorySpaceId,
  ) {
    yield* Transaction;
    const rows = yield* stored(
      "hub-floor-roster",
      sql<{ environment: string }>`
      SELECT environment FROM memory_hub_members
      WHERE space=${space} AND status='active'
        AND (advertised_credential_version IS NOT credential_version
          OR advertised_features_json IS NOT ${fullAdvertisement})
      ORDER BY environment LIMIT ${M.MEMORY_HUB_MAX_MEMBERS}`,
    );
    return rows.map(({ environment }) => M.EnvironmentId.make(environment));
  });
  const learnHubFloor = Effect.fn("MemoryStore.learnHubFloor")(function* (
    space: M.MemorySpaceId,
    now: number,
  ) {
    yield* Transaction;
    yield* stored(
      "hub-floor-learn",
      sql`
      INSERT INTO memory_space_features(space,derived_cap,activated_at)
      VALUES (${space},${M.MEMORY_DERIVED_REVISIONS_MAX},${now})
      ON CONFLICT(space) DO UPDATE SET derived_cap=excluded.derived_cap,activated_at=excluded.activated_at
      WHERE memory_space_features.derived_cap < excluded.derived_cap`,
    );
  });
  const hubFloorActive = Effect.fn("MemoryStore.hubFloorActive")(function* (
    space: M.MemorySpaceId,
  ) {
    yield* Transaction;
    const rows = yield* stored(
      "hub-floor-read",
      sql`
      SELECT 1 FROM memory_space_features WHERE space=${space}
      AND derived_cap >= ${M.MEMORY_DERIVED_REVISIONS_MAX}`,
    );
    return rows.length > 0;
  });
  const negotiateHubFloor = Effect.fn("MemoryStore.negotiateHubFloor")(function* (
    principal: M.MemoryHubPrincipal,
    features: readonly M.MemoryFloor2Feature[] | undefined,
    enabled: boolean,
    now: number,
  ) {
    const space = principal.memorySpaceId;
    const active = yield* hubFloorActive(space);
    const full = M.supportsMemoryFloor2(features);
    if (active && !full) return yield* new M.MemoryHubError({ code: "unsupported_protocol" });
    const advertised =
      features === undefined
        ? null
        : JSON.stringify(M.MEMORY_FLOOR_2.filter((feature) => features.includes(feature)));
    yield* stored(
      "hub-floor-advertise",
      sql`
      UPDATE memory_hub_members
      SET advertised_features_json=${advertised}, advertised_credential_version=${principal.credentialVersion}
      WHERE space=${space} AND environment=${principal.environmentId}
        AND (advertised_features_json IS NOT ${advertised}
          OR advertised_credential_version IS NOT ${principal.credentialVersion})`,
    );
    if (active) return true;
    if (!enabled || !full || (yield* blockingMembers(space)).length > 0) return false;
    yield* learnHubFloor(space, now);
    return true;
  });
  const checkForgetFence = Effect.fn("MemoryStore.checkForgetFence")(function* (
    space: M.MemorySpaceId,
    fence: number | undefined,
  ) {
    yield* Transaction;
    const [watermarks] = yield* stored(
      "hub-forget-watermark",
      sql<{ forgotten: number; current: number }>`
      SELECT coalesce((SELECT last_forget_sequence FROM memory_space_counters WHERE space=${space}),0) AS forgotten,
        max(coalesce((SELECT max(hub_sequence) FROM memory_hub_operations WHERE space=${space}),0),
          coalesce((SELECT checkpoint_sequence FROM memory_hub_retention WHERE space=${space}),0)) AS current`,
    );
    if (fence === undefined || fence < (watermarks?.forgotten ?? 0))
      return yield* new M.MemoryHubError({ code: "source_invalidated" });
    if (fence > (watermarks?.current ?? 0))
      return yield* new M.MemoryHubError({ code: "invalid_output" });
  });
  return { blockingMembers, learnHubFloor, hubFloorActive, negotiateHubFloor, checkForgetFence };
};
export type HubFloorStore = ReturnType<typeof makeHubFloor>;
