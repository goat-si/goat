import { ProviderInstanceId } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import { HOME, OTHER, remoteTask, thread } from "./launchFold.fixtures.ts";
import { resolveThreadPriorityRank, resolveWindowTitleThreadStatus } from "./threadListPriority.ts";

const unread = {
  notificationCompletedAt: "2026-10-27T11:00:00.000Z",
  lastVisitedAt: "2026-10-27T10:30:00.000Z",
};
const rank = (shell: ReturnType<typeof thread>, extra: Partial<typeof unread> = {}) =>
  resolveThreadPriorityRank({
    thread: { ...shell, ...extra },
    wokeAt: null,
    hasChildAttention: false,
  });

describe("resolveThreadPriorityRank", () => {
  it("gives a task.create child on another machine a Priority place only while it waits on a person", () => {
    expect(rank(remoteTask("task", { status: "running" }))).toBeNull();
    expect(rank(remoteTask("task"), unread)).toBeNull();
    expect(rank(remoteTask("task", { approval: true }))).toBe(0);
    expect(rank(remoteTask("task", { input: true, status: "running" }))).toBe(0);
  });

  it("keeps a Priority place for a thread an agent launched on another machine", () => {
    const lane = (status: "running" | "completed") =>
      thread("lane", {
        environmentId: OTHER,
        launchedBy: "parent",
        launcherEnvironment: HOME,
        via: "ssh_thread_launch",
        status,
      });
    expect(rank(lane("running"))).toBe(1);
    expect(rank(lane("completed"), unread)).toBe(2);
  });
});

describe("resolveWindowTitleThreadStatus", () => {
  it("titles the window with live work and requests only", () => {
    const runtime = {
      status: "running" as const,
      activeRunId: null,
      providerInstanceId: ProviderInstanceId.make("codex"),
      providerName: "Codex",
      lastError: null,
      updatedAt: "2026-03-09T10:00:00.000Z",
    };
    const idle = { hasPendingApprovals: false, hasPendingUserInput: false, runtime: null };
    const cases = [
      [{ ...idle, hasPendingApprovals: true, runtime }, "Needs approval"],
      [{ ...idle, hasPendingUserInput: true }, "Needs your input"],
      [{ ...idle, runtime: { ...runtime, status: "preparing" as const } }, "Working"],
      [{ ...idle, runtime }, "Working"],
      [{ ...idle, runtime, pendingGuestMessageCount: 1 }, "Working"],
      [{ ...idle, runtime, blockedOnThreadWait: true }, "Working"],
      [{ ...idle, runtime: { ...runtime, status: "idle" as const } }, null],
      [{ ...idle, runtime: { ...runtime, status: "failed" as const } }, null],
      [{ ...idle, runtime: { ...runtime, status: "completed" as const } }, null],
      [idle, null],
    ] as const;
    for (const [shell, title] of cases) {
      expect(resolveWindowTitleThreadStatus(shell)).toBe(title);
    }
  });
});
