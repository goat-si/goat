import type { ThreadId } from "@goat/contracts";
import * as NodeBuffer from "node:buffer";

export interface SubagentPage {
  readonly after?: ThreadId;
  readonly limit: number;
}

export const MAX_SUBAGENT_PAGE_SIZE = 128;
export const subagentPageLimit = (page: SubagentPage | undefined) =>
  page === undefined
    ? -1
    : Number.isFinite(page.limit)
      ? Math.min(MAX_SUBAGENT_PAGE_SIZE, Math.max(1, Math.trunc(page.limit)))
      : MAX_SUBAGENT_PAGE_SIZE;

const compareIds = (a: ThreadId, b: ThreadId) =>
  NodeBuffer.Buffer.compare(NodeBuffer.Buffer.from(a), NodeBuffer.Buffer.from(b));

export function selectSubagentPage(ids: Iterable<ThreadId>, page: SubagentPage): ThreadId[] {
  const limit = subagentPageLimit(page);
  const selected: ThreadId[] = [];
  for (const id of ids) {
    if (page.after !== undefined && compareIds(id, page.after) <= 0) continue;
    selected.push(id);
    selected.sort(compareIds);
    if (selected.length > limit) selected.pop();
  }
  return selected;
}
