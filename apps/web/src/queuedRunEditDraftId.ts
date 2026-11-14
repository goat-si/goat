import { parseScopedThreadKey, scopedThreadKey } from "@goat/client-runtime/environment";
import type { ScopedThreadRef, ThreadId } from "@goat/contracts";

const PREFIX = "queued-edit:";
export function queuedRunEditDraftKey(ref: ScopedThreadRef, runId: string): string {
  return `${PREFIX}${scopedThreadKey(ref)}:${encodeURIComponent(runId)}`;
}
export function queuedRunEditThreadId(draftId: string): ThreadId | null {
  if (!draftId.startsWith(PREFIX)) return null;
  const rest = draftId.slice(PREFIX.length);
  return parseScopedThreadKey(rest.slice(0, rest.lastIndexOf(":")))?.threadId ?? null;
}
