import type { OrchestrationV2AppThread } from "@goat/contracts";

export const parentClosed = (
  parent:
    | Pick<OrchestrationV2AppThread, "settledOverride" | "archivedAt" | "deletedAt">
    | undefined,
) =>
  parent !== undefined &&
  (parent.settledOverride === "settled" || parent.archivedAt !== null || parent.deletedAt !== null);
