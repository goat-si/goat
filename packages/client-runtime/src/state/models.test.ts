import { expect, it } from "vite-plus/test";
import { EnvironmentId, RunId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import { v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import { presentThreadShell } from "./models.ts";

it("preserves absent versus null cursors and the selected run's completion decision", () => {
  const environmentId = EnvironmentId.make("env");
  expect(presentThreadShell(environmentId, v2ThreadShell).notificationCompletedAt).toBeUndefined();
  const at = DateTime.makeUnsafe("2026-10-15T00:00:00.000Z");
  const thread = presentThreadShell(environmentId, {
    ...v2ThreadShell,
    latestRunId: RunId.make("run"),
    status: "completed",
    latestRunCompletedAt: at,
    latestRunCompletionNotification: "silent",
    notificationCompletedAt: null,
    markedUnreadCompletionAt: at,
  });
  expect(thread.notificationCompletedAt).toBeNull();
  expect(thread.markedUnreadCompletionAt).toBe("2026-10-15T00:00:00.000Z");
  expect(thread.latestRun?.completionNotification).toBe("silent");
});
