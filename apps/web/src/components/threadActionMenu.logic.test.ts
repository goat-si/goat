import { describe, expect, it } from "vite-plus/test";

import { buildThreadActionMenuItems, type ThreadActionMenuState } from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  canOperate: true,
  branch: null,
  projectFilter: null,
  isPinned: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
  },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

function allIds(state: ThreadActionMenuState): string[] {
  const flatten = (items: ReturnType<typeof buildThreadActionMenuItems>): string[] =>
    items.flatMap((item) => [item.id, ...(item.children ? flatten(item.children) : [])]);
  return flatten(buildThreadActionMenuItems(state));
}

describe("buildThreadActionMenuItems", () => {
  it("offers separate thread chip and ID actions to read-only clients", () => {
    const copy = buildThreadActionMenuItems({ ...baseState, canOperate: false }).find(
      (item) => item.id === "copy",
    );
    expect(copy?.children?.map((item) => item.id)).toEqual(
      expect.arrayContaining(["copy-thread", "copy-thread-id"]),
    );
    expect(
      copy?.children
        ?.filter((item) => ["copy-thread", "copy-thread-id"].includes(item.id))
        .every((item) => !item.disabled),
    ).toBe(true);
  });
  it.each([false, true])(
    "disables both lifecycle directions without permission (reversed: %s)",
    (reversed) => {
      const items = buildThreadActionMenuItems({
        ...baseState,
        canOperate: false,
        isPinned: reversed,
        isSettled: reversed,
        isSnoozed: reversed,
      });
      const expected = reversed
        ? [
            "unpin",
            "unsettle",
            "unsnooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ]
        : [
            "pin",
            "settle",
            "snooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ];
      expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(expected);
      expect(
        items.find((item) => item.id === "snooze")?.children?.every((child) => child.disabled) ??
          true,
      ).toBe(true);
    },
  );

  it("leaves project actions and title edits out of the global agent's menu", () => {
    const global = allIds({ ...baseState, branch: "main", globalAgent: true });
    for (const hidden of [
      "new-thread-on-branch",
      "project-settings",
      "rename",
      "regenerate-title",
    ]) {
      expect(global).not.toContain(hidden);
    }
    expect(global).toEqual(expect.arrayContaining(["pin", "copy-path", "archive", "delete"]));
    const ordinary = allIds({ ...baseState, branch: "main" });
    expect(ordinary).toEqual(
      expect.arrayContaining(["new-thread-on-branch", "project-settings", "rename"]),
    );
  });

  it("disables archive and turning into a project while the thread is running", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      isRunning: true,
      canTurnIntoProject: true,
    });
    expect(items.find((item) => item.id === "archive")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "turn-into-project")?.disabled).toBe(true);
  });

  describe("fork entry", () => {
    const fork = {
      canFork: true,
      canForkIntoWorktree: true,
      inWorktree: false,
      needsServerUpdate: false,
    } as const;
    const forkItem = (state: Partial<ThreadActionMenuState>) =>
      buildThreadActionMenuItems({ ...baseState, branch: "main", ...state }).find((item) =>
        item.id.startsWith("fork"),
      );

    it("offers both workspaces in a submenu after New thread on the branch", () => {
      const ids = buildThreadActionMenuItems({ ...baseState, branch: "main", fork }).map(
        (item) => item.id,
      );
      expect(ids.indexOf("fork")).toBe(ids.indexOf("new-thread-on-branch") + 1);
      expect(forkItem({ fork })).toMatchObject({
        id: "fork",
        label: "Fork thread",
        disabled: false,
        children: [
          { id: "fork:current", label: "Fork thread" },
          { id: "fork:worktree", label: "Fork thread in new worktree" },
        ],
      });
    });

    it("names the same worktree when the thread already lives in one", () => {
      expect(forkItem({ fork: { ...fork, inWorktree: true } })?.children?.[0]?.label).toBe(
        "Fork thread in same worktree",
      );
      expect(
        forkItem({ fork: { ...fork, inWorktree: true, canForkIntoWorktree: false } })?.label,
      ).toBe("Fork thread in same worktree");
    });

    it("is a single item when a new worktree is not possible, and disabled without a turn", () => {
      expect(forkItem({ fork: { ...fork, canForkIntoWorktree: false } })).toMatchObject({
        id: "fork:current",
        label: "Fork thread",
        disabled: false,
      });
      expect(
        forkItem({ fork: { ...fork, canFork: false, canForkIntoWorktree: false } }),
      ).toMatchObject({ id: "fork:current", disabled: true });
    });

    it("asks for a server update on a hub-proxied server that cannot fork", () => {
      expect(
        forkItem({
          fork: {
            canFork: false,
            canForkIntoWorktree: false,
            inWorktree: false,
            needsServerUpdate: true,
          },
        }),
      ).toMatchObject({ label: "Fork thread (update this server)", disabled: true });
    });

    it("is absent without fork state and for the global agent", () => {
      expect(forkItem({ fork: null })).toBeUndefined();
      expect(forkItem({})).toBeUndefined();
      expect(forkItem({ fork, globalAgent: true })).toBeUndefined();
    });
  });
});
