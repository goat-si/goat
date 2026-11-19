import { expect, it } from "vite-plus/test";
import { threadListV2RowAccessibilityLabel } from "./thread-list-v2-label";

it("includes visible thread status and time along with worktree information", () => {
  expect(
    threadListV2RowAccessibilityLabel({
      thread: { title: "Thread", worktreePath: "/repo/work", branch: "feature" },
      isRegeneratingTitle: false,
      statusLabel: "Waiting",
      timeLabel: "2m",
    }),
  ).toBe("Thread, Waiting, 2m, in worktree work (feature)");
});
