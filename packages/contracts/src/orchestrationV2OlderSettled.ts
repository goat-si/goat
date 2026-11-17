import * as DateTime from "effect/DateTime";

import type { OrchestrationV2ThreadShell } from "./orchestrationV2.ts";

/**
 * A settled top-level thread settled before `beforeMs`. Shells that omit older settled threads
 * count every such thread, so the server and clients share this one rule.
 */
export function isOlderSettledThreadShell(
  thread: Pick<OrchestrationV2ThreadShell, "lineage" | "settledOverride" | "settledAt">,
  beforeMs: number,
): boolean {
  return (
    thread.lineage.relationshipToParent !== "subagent" &&
    thread.settledOverride === "settled" &&
    thread.settledAt !== null &&
    DateTime.toEpochMillis(thread.settledAt) < beforeMs
  );
}
