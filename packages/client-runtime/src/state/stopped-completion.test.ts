import { expect, it } from "vite-plus/test";
import { hasUnseenCompletion } from "./threadListPriority.ts";

it("ignores a stopped latest run on an older server but retains earlier unread and manual marks", () => {
  const stopped = {
    latestRun: { completedAt: "2026-01-01T12:00:00Z", status: "interrupted" as const },
    lastVisitedAt: "2026-01-01T10:00:00Z",
  };
  expect(hasUnseenCompletion(stopped)).toBe(false);
  expect(hasUnseenCompletion({ ...stopped, notificationCompletedAt: "2026-01-01T11:00:00Z" })).toBe(
    true,
  );
  expect(
    hasUnseenCompletion({
      ...stopped,
      notificationCompletedAt: null,
      markedUnreadCompletionAt: "2026-01-01T11:00:00Z",
    }),
  ).toBe(true);
});
