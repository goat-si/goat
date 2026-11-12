import { ThreadId } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  MAX_SUBAGENT_PAGE_SIZE,
  selectSubagentPage,
  subagentPageLimit,
} from "./SubagentPagination.ts";

describe("subagent catch-up pagination", () => {
  it("returns bounded, ordered pages without retaining the input", () => {
    const ids = ["z", "b", "a", "\u{10000}", "\ue000"].map((value) => ThreadId.make(value));
    const first = selectSubagentPage(ids, { limit: 2 });
    expect(first).toEqual(["a", "b"]);
    const next = selectSubagentPage(ids, { limit: 2, after: ThreadId.make("b") });
    expect(next).toEqual(["z", "\ue000"]);
    expect(selectSubagentPage(ids, { limit: 2, after: ThreadId.make("\ue000") })).toEqual([
      "\u{10000}",
    ]);
    expect(subagentPageLimit({ limit: 10000 })).toBe(MAX_SUBAGENT_PAGE_SIZE);
    expect(subagentPageLimit({ limit: Number.NaN })).toBe(MAX_SUBAGENT_PAGE_SIZE);
  });
});
