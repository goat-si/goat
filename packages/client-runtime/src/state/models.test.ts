import { expect, it } from "vite-plus/test";
import { EnvironmentId, ProviderThreadId, RunId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import { v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import { presentThreadShell } from "./models.ts";
import { resolveThreadListStatus, resolveThreadPriorityRank } from "./threadListPriority.ts";

it("shows a held starting run as waiting and resumes working when released", () => {
  const runId = RunId.make("held-run");
  const shell = {
    ...v2ThreadShell,
    latestRunId: runId,
    activeRunId: runId,
    status: "starting" as const,
    activityRunStatus: "starting" as const,
  };
  const status = (held: boolean) =>
    resolveThreadListStatus(
      presentThreadShell(EnvironmentId.make("env"), { ...shell, latestRunStartHeld: held }),
    );
  expect(status(true)).toBe("waiting");
  expect(status(false)).toBe("working");
});

it("regression #2988: an imported session with only a provider reference stays out of Priority", () => {
  const environmentId = EnvironmentId.make("env");
  const imported = {
    ...v2ThreadShell,
    activeProviderThreadId: ProviderThreadId.make("provider-thread-imported"),
    settledOverride: "settled" as const,
    settledAt: v2ThreadShell.updatedAt,
  };
  const rank = (shell: typeof imported, pendingUserInput = false) =>
    resolveThreadPriorityRank({
      thread: {
        ...presentThreadShell(environmentId, shell),
        ...(pendingUserInput ? { hasPendingUserInput: true } : {}),
      },
      wokeAt: null,
      hasChildAttention: false,
    });

  expect(rank(imported)).toBeNull();
  expect(
    rank({
      ...imported,
      pendingBackgroundTasks: [{ taskId: "watch", kind: "monitor", awaited: true }],
    }),
  ).toBe(1);
  expect(rank(imported, true)).toBe(0);
});

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
