import { expect, it } from "vite-plus/test";
import { hasUnseenCompletion } from "./Sidebar.logic";

it("preserves older automatic and manual unread through quiet completions and acknowledges actual visits", () => {
  const thread = {
    latestRun: { completedAt: "2026-10-15T04:00:00.000Z" },
    lastVisitedAt: "2026-10-15T00:00:00.000Z",
    notificationCompletedAt: "2026-10-15T01:00:00.000Z",
  };
  expect(hasUnseenCompletion(thread)).toBe(true);
  expect(hasUnseenCompletion({ ...thread, lastVisitedAt: "2026-10-15T02:00:00.000Z" })).toBe(false);
  expect(hasUnseenCompletion({ ...thread, notificationCompletedAt: null })).toBe(false);
  expect(hasUnseenCompletion({ ...thread, notificationCompletedAt: undefined })).toBe(true);
  expect(
    hasUnseenCompletion({
      ...thread,
      notificationCompletedAt: null,
      markedUnreadCompletionAt: "2026-10-15T03:00:00.000Z",
    }),
  ).toBe(true);
  expect(hasUnseenCompletion({ ...thread, lastVisitedAt: null })).toBe(false);
});
