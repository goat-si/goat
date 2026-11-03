import { describe, expect, it } from "vite-plus/test";
import { threadListV2RowAccessibilityLabel } from "./thread-list-v2-label";

describe("thread list screen-reader label (#2394)", () => {
  it.each([
    {
      worktreePath: "/repos/my-tree",
      branch: "feature",
      label: "Thread, in worktree my-tree (feature)",
    },
    { worktreePath: "C:\\", branch: "feature", label: "Thread, in a worktree (feature)" },
    { worktreePath: "C:\\", branch: null, label: "Thread, in a worktree" },
    { worktreePath: null, branch: "feature", label: "Thread" },
  ])("reads $worktreePath with branch $branch", ({ worktreePath, branch, label }) => {
    expect(
      threadListV2RowAccessibilityLabel({
        thread: { title: "Thread", worktreePath, branch },
        isRegeneratingTitle: false,
      }),
    ).toBe(label);
  });

  it("includes queued and title regeneration states in the label", () => {
    expect(
      threadListV2RowAccessibilityLabel({
        thread: { title: "Thread", worktreePath: null, branch: null },
        hasQueuedMessages: true,
        isRegeneratingTitle: true,
      }),
    ).toBe("Thread, messages queued to send, regenerating title");
  });
});
