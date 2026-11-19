import type { EnvironmentId, ThreadId } from "@goat/contracts";
import { scopedThreadKey } from "../lib/scopedEntities";
import { getQueuedRunEdit, queuedEditDraftKey } from "./queued-run-edit";

/** Resolve per call so callbacks created before editing still target the current draft. */
export function activeComposerDraftKey(thread: {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
}): string {
  const threadKey = scopedThreadKey(thread.environmentId, thread.id);
  const edit = getQueuedRunEdit(threadKey);
  return edit === null ? threadKey : queuedEditDraftKey(threadKey, edit.runId);
}
