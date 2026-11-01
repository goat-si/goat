import { scopeThreadRef, scopedThreadKey } from "@goat/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import { sortPriorityThreadsForSidebar } from "../Sidebar.logic";

const environmentId = EnvironmentId.make("environment-1");
const at = (time: string) => `2026-10-30T${time}:00.000Z`;

function thread(
  id: string,
  createdAt: string,
  latestUserMessageAt: string | null,
  latestUserAuthoredMessageAt?: string | null,
) {
  return {
    environmentId,
    id: ThreadId.make(id),
    createdAt,
    updatedAt: createdAt,
    latestUserMessageAt,
    ...(latestUserAuthoredMessageAt === undefined ? {} : { latestUserAuthoredMessageAt }),
  };
}

const keyOf = (candidate: ReturnType<typeof thread>) =>
  scopedThreadKey(scopeThreadRef(candidate.environmentId, candidate.id));

describe("sortPriorityThreadsForSidebar", () => {
  it("an older thread the user just prompted sorts above a newer thread of the same rank", () => {
    const prompted = thread("old-prompted", at("09:00"), at("11:30"), at("11:30"));
    const fresh = thread("new", at("10:00"), at("10:00"), at("10:00"));
    // A wake or agent message moves latestUserMessageAt but is not the user's prompt.
    const woken = thread("woken", at("10:30"), at("11:45"), at("10:30"));
    const launched = thread("launched", at("10:15"), at("11:50"), null);
    // Older servers send no authored time; their latest user message stands in.
    const legacy = thread("legacy", at("08:00"), at("11:40"));
    const asking = thread("asking", at("07:00"), null);
    const threads = [fresh, woken, launched, prompted, legacy, asking];
    const ranks = new Map(threads.map((row) => [keyOf(row), row === asking ? 0 : 1]));
    const ordered = sortPriorityThreadsForSidebar(threads, ranks);
    expect(ordered.map((row) => row.id)).toEqual([
      "asking",
      "legacy",
      "old-prompted",
      "woken",
      "launched",
      "new",
    ]);
    const streamed = threads.map((row) =>
      row === fresh ? { ...row, updatedAt: "2999-01-01T00:00:00.000Z" } : row,
    );
    expect(sortPriorityThreadsForSidebar(streamed, ranks).map((row) => row.id)).toEqual(
      ordered.map((row) => row.id),
    );
  });
});
