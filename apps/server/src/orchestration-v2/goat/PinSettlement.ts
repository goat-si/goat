import type { OrchestrationV2AppThread } from "@goat/contracts";
import type * as DateTime from "effect/DateTime";

export function pinSettlement(thread: OrchestrationV2AppThread, now: DateTime.Utc) {
  return thread.settledOverride === "settled"
    ? { settledOverride: "active" as const, settledAt: null, unsettledAt: now }
    : {
        settledOverride: thread.settledOverride,
        settledAt: thread.settledAt,
        unsettledAt: thread.unsettledAt,
      };
}
