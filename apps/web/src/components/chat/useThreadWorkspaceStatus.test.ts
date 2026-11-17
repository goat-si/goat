import { describe, expect, it } from "vite-plus/test";

import { workspaceItemRefreshKey } from "./useThreadWorkspaceStatus";

// A terminal-triggered restore starts no run; its notice is the signal the banner refreshes on.
describe("workspaceItemRefreshKey", () => {
  it("changes with the thread's items only while the worktree needs attention", () => {
    expect(workspaceItemRefreshKey(true, 4)).not.toBe(workspaceItemRefreshKey(true, 5));
    expect(workspaceItemRefreshKey(false, 4)).toBeNull();
    expect(workspaceItemRefreshKey(false, 5)).toBeNull();
    expect(workspaceItemRefreshKey(true, null)).toBeNull();
  });
});
