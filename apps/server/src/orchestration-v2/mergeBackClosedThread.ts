import type { OrchestrationV2ThreadProjection } from "@goat/contracts";

export function mergeBackClosedThread(
  source: OrchestrationV2ThreadProjection["thread"],
  target: OrchestrationV2ThreadProjection["thread"],
) {
  if (source.deletedAt !== null) return `Thread ${source.id} was deleted.`;
  if (target.deletedAt !== null || target.archivedAt !== null)
    return `Thread ${target.id} is archived or deleted.`;
  return null;
}
