import { describe, expect, it } from "vite-plus/test";
import type { ThreadForkAvailability } from "@goat/client-runtime/state/thread-workflows";

import {
  buildForkMenuActions,
  forkChoices,
  forkEntryChoice,
  forkWorkspaceForMenuEvent,
  responseForkChoice,
} from "./threadForkChoices";

const availability = (overrides: Partial<ThreadForkAvailability> = {}): ThreadForkAvailability => ({
  canFork: true,
  canForkIntoWorktree: true,
  inWorktree: false,
  reason: null,
  ...overrides,
});

describe("thread fork menu actions", () => {
  it("hides the entry without availability", () => {
    expect(buildForkMenuActions(null)).toEqual([]);
  });

  it("offers a submenu with both destinations when a worktree is possible", () => {
    const [entry] = buildForkMenuActions(availability());
    expect(entry).toMatchObject({
      id: "fork",
      title: "Fork thread",
      attributes: { disabled: false },
    });
    expect(entry?.subactions?.map((action) => [action.id, action.title])).toEqual([
      ["fork:current", "Fork thread"],
      ["fork:worktree", "Fork thread in new worktree"],
    ]);
  });

  it("names the same worktree for a thread that already lives in one", () => {
    const [entry] = buildForkMenuActions(availability({ inWorktree: true }));
    expect(entry?.subactions?.[0]?.title).toBe("Fork thread in same worktree");
  });

  it("offers a single in-place action when no worktree is possible", () => {
    expect(buildForkMenuActions(availability({ canForkIntoWorktree: false }))).toEqual([
      {
        id: "fork:current",
        title: "Fork thread",
        image: "arrow.triangle.branch",
        attributes: { disabled: false },
      },
    ]);
  });

  it("disables the entry and shows why when the thread cannot be forked", () => {
    const reason = "Update this server to fork from here.";
    const [entry] = buildForkMenuActions(
      availability({ canFork: false, canForkIntoWorktree: false, reason }),
    );
    expect(entry).toMatchObject({
      id: "fork:current",
      attributes: { disabled: true },
      subtitle: reason,
    });
  });

  it("maps the menu events to workspaces and ignores others", () => {
    expect(forkWorkspaceForMenuEvent("fork:current")).toEqual({ type: "current" });
    expect(forkWorkspaceForMenuEvent("fork:worktree")).toEqual({ type: "worktree" });
    expect(forkWorkspaceForMenuEvent("fork")).toBeNull();
    expect(forkWorkspaceForMenuEvent("rename")).toBeNull();
  });
});

describe("fork entry choice", () => {
  it("asks where only when a worktree is possible", () => {
    expect(forkEntryChoice(availability())).toEqual({ kind: "choose" });
    expect(forkEntryChoice(availability({ canForkIntoWorktree: false }))).toEqual({
      kind: "current",
    });
    expect(
      forkEntryChoice(availability({ canFork: false, canForkIntoWorktree: false, reason: "No." })),
    ).toEqual({ kind: "blocked", reason: "No." });
  });

  it("keeps a side chat's response fork in place on a server that makes worktrees", () => {
    expect(responseForkChoice({ availability: availability(), isSideChat: true })).toEqual({
      kind: "current",
    });
    expect(responseForkChoice({ availability: availability(), isSideChat: false })).toEqual({
      kind: "choose",
    });
    expect(
      responseForkChoice({
        availability: availability({ canFork: false, canForkIntoWorktree: false, reason: "No." }),
        isSideChat: true,
      }),
    ).toEqual({ kind: "blocked", reason: "No." });
  });

  it("labels the response picker like the desktop app", () => {
    expect(forkChoices(false, "response").map((choice) => choice.label)).toEqual([
      "Fork in this workspace",
      "Fork in a new worktree",
    ]);
    expect(forkChoices(true, "response")[0].label).toBe("Fork in this worktree");
    expect(forkChoices(true, "thread").map((choice) => choice.workspace.type)).toEqual([
      "current",
      "worktree",
    ]);
  });
});
