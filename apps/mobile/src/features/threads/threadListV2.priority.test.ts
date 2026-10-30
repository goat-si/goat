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
  getThreadListV2OrderedSection,
  resolveThreadListV2SwipeActions,
  type ThreadListV2Item,
  type ThreadListV2ListItem,
} from "./threadListV2";
import { threadListV2ReorderExcludedKeys } from "./threadListV2LaunchFold";
import { publishHeldPriorityKeys } from "./threadListV2PriorityHolds";
import { threadListV2PriorityReadPlans } from "./threadListV2PriorityRead";

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

  it("leaves a held Priority row out of every reorder path, so moves skip past it", () => {
    const threads = ["above", "held", "below"].map((id, index) =>
      makeThread(id, { activeOrderKey: `a${index}` }),
    );
    const placement = { threads, now: NOW };
    const ordered = () =>
      getThreadListV2OrderedSection({
        ...placement,
        section: "active",
        excludedThreadKeys: threadListV2ReorderExcludedKeys(placement),
      }).map((thread) => String(thread.id));
    expect(ordered()).toEqual(["above", "held", "below"]);
    publishHeldPriorityKeys("list", new Set([`${environmentId}:held`]));
    try {
      expect(ordered()).toEqual(["above", "below"]);
    } finally {
      publishHeldPriorityKeys("list", null);
    }
    expect(ordered()).toEqual(["above", "held", "below"]);
  });

  it("keeps a launcher with running work under it when Clear read releases read rows", () => {
    const read = makeThread("read", { latestRun: completedRun, lastVisitedAt: AFTER });
    const launcher = makeThread("launcher");
    const row = (thread: EnvironmentThreadShell, lift: ThreadListV2Item["lift"]) => ({
      thread,
      variant: "card" as const,
      snoozed: false,
      pinned: false,
      wokeAt: null,
      isLast: false,
      lift,
    });
    const plans = threadListV2PriorityReadPlans({
      rows: [row(read, null), row(launcher, "working")],
      foldedUnseen: [],
      canOperate: () => true,
    });
    expect(plans.clear.releaseKeys).toEqual([`${environmentId}:read`]);
    expect(plans.markAll.markRead).toEqual([]);
  });

  it("keeps the pin on a pinned thread that searching finds in Priority", () => {
    const layout = buildThreadListV2Items({
      threads: [makeThread("busy pinned", { runtime: running, pinnedAt: NOW })],
      environmentId: null,
      searchQuery: "busy",
      now: NOW,
    });
    expect(layout.items[0]?.pinned).toBe(true);
  });

  it("lets a settled thread in Priority un-settle, though it shows as a card", () => {
    const actions = (settled: boolean) =>
      resolveThreadListV2SwipeActions({
        variant: "card",
        settlementSupported: true,
        snoozeSupported: false,
        snoozable: false,
        settled,
      }).primary;
    expect(actions(true)).toBe("unsettle");
    expect(actions(false)).toBe("settle");
  });

  it("leaves another list's held rows out of a list's reorder plan, but not its own published ones", () => {
    const threads = [makeThread("held")];
    const excluded = (listId?: string) =>
      threadListV2ReorderExcludedKeys({ threads, now: NOW, listId }).has(`${environmentId}:held`);
    publishHeldPriorityKeys("home", new Set([`${environmentId}:held`]));
    try {
      expect(excluded("home")).toBe(false);
      expect(excluded("sidebar")).toBe(true);
      expect(excluded()).toBe(true);
    } finally {
      publishHeldPriorityKeys("home", null);
    }
    expect(excluded("sidebar")).toBe(false);
  });
});
