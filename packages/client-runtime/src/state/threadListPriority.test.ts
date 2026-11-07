import { describe, expect, it } from "vite-plus/test";

import { HOME, OTHER, remoteTask, thread } from "./launchFold.fixtures.ts";
import { resolveThreadPriorityRank } from "./threadListPriority.ts";

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
