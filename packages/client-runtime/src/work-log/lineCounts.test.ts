import type { OrchestrationV2TurnItem } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import { fileChangeGroupLineCounts, fileChangeLineCounts } from "./lineCounts.ts";

function fileChange(
  counts: { additions?: number; deletions?: number },
  status: OrchestrationV2TurnItem["status"] = "completed",
): OrchestrationV2TurnItem {
  return {
    type: "file_change",
    fileName: "src/a.ts",
    status,
    ...counts,
  } as OrchestrationV2TurnItem;
}

describe("fileChangeLineCounts", () => {
  it("hides counts for failed edits and edits that changed nothing", () => {
    expect(fileChangeLineCounts(fileChange({ additions: 3, deletions: 1 }))).toEqual({
      additions: 3,
      deletions: 1,
    });
    expect(fileChangeLineCounts(fileChange({ additions: 3 }, "failed"))).toBeUndefined();
    expect(fileChangeLineCounts(fileChange({ additions: 0, deletions: 0 }))).toBeUndefined();
    expect(fileChangeLineCounts(fileChange({}))).toBeUndefined();
  });
});

describe("fileChangeGroupLineCounts", () => {
  it("totals a group only when every edit reported counts", () => {
    expect(
      fileChangeGroupLineCounts([
        fileChange({ additions: 3, deletions: 1 }),
        fileChange({ additions: 2 }),
        fileChange({}, "failed"),
        undefined,
      ]),
    ).toEqual({ additions: 5, deletions: 1 });
    expect(
      fileChangeGroupLineCounts([fileChange({ additions: 3, deletions: 1 }), fileChange({})]),
    ).toBeUndefined();
  });
});
