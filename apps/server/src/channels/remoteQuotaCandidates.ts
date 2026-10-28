import { QuotaPool, ServerProviderUsageLimits } from "@goat/contracts";
import { verdictWindows } from "@goat/shared/quotaVerdict";
import * as Schema from "effect/Schema";

import type { PlacementCandidate } from "./channelPlacement.ts";

/** The quota goat_host_status reports for each provider instance on that machine. */
const HostQuotas = Schema.Struct({
  hosts: Schema.Array(
    Schema.Struct({
      metrics: Schema.optional(
        Schema.Struct({
          quotaPool: Schema.optional(QuotaPool),
          quotas: Schema.Array(
            Schema.Struct({ instanceId: Schema.String, limits: ServerProviderUsageLimits }),
          ),
        }),
      ),
    }),
  ),
});
export type HostQuotas = typeof HostQuotas.Type;
export const decodeHostQuotas = Schema.decodeUnknownEffect(HostQuotas);

/** One remote instance's quota for placement: its windows and blocks, and its raw pool when the host sent it. */
export function remoteQuotaFields(
  status: HostQuotas | undefined,
  instanceId: string,
): Pick<PlacementCandidate<unknown>, "windows" | "checkedAt" | "quotaPool"> {
  const metrics = status?.hosts[0]?.metrics;
  const limits = metrics?.quotas.find((quota) => quota.instanceId === instanceId)?.limits;
  const windows = limits === undefined ? [] : verdictWindows(limits);
  const reference = limits?.quotaPool;
  return {
    windows: windows.length === 0 ? null : windows,
    checkedAt: limits?.checkedAt,
    quotaPool:
      reference !== undefined && metrics?.quotaPool?.producer.homeId === reference.homeId
        ? metrics.quotaPool.providers.find((item) => item.provider === reference.provider)
        : undefined,
  };
}
