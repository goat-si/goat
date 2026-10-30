import type { EnvironmentThreadShell } from "@goat/client-runtime/state/shell";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import { makeThreadShellFixture } from "../../test-fixtures";
import {
  buildThreadListV2Items,
  buildThreadListV2ListItems,
  type ThreadListV2ListItem,
} from "./threadListV2";

type LayoutInput = Parameters<typeof buildThreadListV2Items>[0];

const environmentId = EnvironmentId.make("environment-1");
const NOW = "2026-06-02T00:00:00.000Z";

const makeThread = (id: string, overrides: Partial<EnvironmentThreadShell> = {}) =>
  makeThreadShellFixture({ environmentId, id: ThreadId.make(id), title: id, ...overrides });

const running = {
  status: "running" as const,
  activeRunId: null,
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerName: "Codex",
  lastError: null,
  updatedAt: NOW,
};

const BEFORE = "2026-06-01T09:00:00.000Z";
const AFTER = "2026-06-01T11:00:00.000Z";
const completedRun = {
  runId: RunId.make("run-1"),
  status: "completed" as const,
  requestedAt: "2026-06-01T09:30:00.000Z",
  startedAt: "2026-06-01T09:30:00.000Z",
  completedAt: "2026-06-01T10:00:00.000Z",
  assistantMessageId: null,
};

const label = (item: ThreadListV2ListItem) =>
  item.type === "v2-thread"
    ? String(item.item.thread.id)
    : item.type === "v2-pending"
      ? item.pendingTask.title
      : item.type;

function makePendingTask(id: string): PendingNewTask {
  const creation = {
    projectId: ProjectId.make("project-1"),
    workspaceMode: "worktree" as const,
    branch: null,
    worktreePath: null,
  };
  return {
    kind: "pending",
    key: `pending-task:${id}`,
    environmentId,
    projectId: creation.projectId,
    projectTitle: undefined,
    projectCwd: undefined,
    branch: null,
    title: id,
    createdAt: NOW,
    message: {
      environmentId,
      threadId: ThreadId.make(`thread-${id}`),
      messageId: MessageId.make(id),
      commandId: CommandId.make(`command-${id}`),
      text: id,
      attachments: [],
      createdAt: NOW,
      creation,
    },
    creation,
  };
}

describe("threadListV2 Priority", () => {
  it("keeps a thread listed when it starts running, with the default collapsed Working shelf", () => {
    const listedIds = (threads: EnvironmentThreadShell[]) =>
      buildThreadListV2Items({
        threads,
        environmentId: null,
        searchQuery: "",
        now: NOW,
        workingShelfEnabled: true,
        workingShelfExpanded: false,
      }).items.map((item) => String(item.thread.id));

    expect(listedIds([makeThread("other"), makeThread("task")])).toContain("task");
    expect(listedIds([makeThread("other"), makeThread("task", { runtime: running })])).toContain(
      "task",
    );
  });

  it("puts Priority and its header above queued tasks and the inbox", () => {
    const layout = buildThreadListV2Items({
      threads: [makeThread("idle"), makeThread("busy", { runtime: running })],
      environmentId: null,
      searchQuery: "",
      now: NOW,
      workingShelfEnabled: true,
    });
    const list = buildThreadListV2ListItems({
      items: layout.items,
      pendingTasks: [makePendingTask("queued")],
      priorityCount: layout.priorityCount,
      moveAvailability: new Map([
        [`${environmentId}:busy`, { canMoveUp: true, canMoveDown: true }],
        [`${environmentId}:idle`, { canMoveUp: true, canMoveDown: true }],
      ]),
    });
    expect(list.map(label)).toEqual(["v2-priority-header", "busy", "queued", "idle"]);
    // Priority orders by urgency, so its rows offer no manual moves.
    expect(list.filter((item) => item.type === "v2-thread").map((item) => item.canMoveUp)).toEqual([
      false,
      true,
    ]);
  });

  it("lists an unread completion in Priority, holds it once read, and lets Clear read release it", () => {
    const unread = makeThread("done", { latestRun: completedRun, lastVisitedAt: BEFORE });
    const read = { ...unread, lastVisitedAt: AFTER };
    const build = (thread: EnvironmentThreadShell, input: Partial<LayoutInput> = {}) =>
      buildThreadListV2Items({
        threads: [makeThread("other"), thread],
        environmentId: null,
        searchQuery: "",
        now: NOW,
        ...input,
      });
    const unreadLayout = build(unread);
    expect(unreadLayout.priorityThreads?.map((thread) => thread.id)).toEqual(["done"]);

    expect(build(read).priorityCount).toBe(0);
    const holds = new Map([[`${environmentId}:done`, read.settledOverride]]);
    expect(build(read, { priorityHolds: holds }).priorityThreads?.map((t) => t.id)).toEqual([
      "done",
    ]);
    const released = build(read, {
      priorityHolds: holds,
      priorityReleases: new Set([`${environmentId}:done`]),
    });
    expect(released.priorityCount).toBe(0);
    expect(released.items.map((item) => String(item.thread.id))).toContain("done");

    const settled = { ...read, settledOverride: "settled" as const, settledAt: NOW };
    expect(build(settled, { priorityHolds: holds }).priorityCount).toBe(0);
  });

  it("lists matches without sections while searching", () => {
    const layout = buildThreadListV2Items({
      threads: [makeThread("busy task", { runtime: running })],
      environmentId: null,
      searchQuery: "busy",
      now: NOW,
    });
    expect(layout.priorityCount).toBe(0);
    expect(layout.priorityThreads).toBeNull();
    expect(layout.items.map((item) => String(item.thread.id))).toEqual(["busy task"]);
  });
});
