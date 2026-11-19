import { EnvironmentId } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";
import { isBranchHoldCurrent } from "./BranchToolbar.logic";

describe("isBranchHoldCurrent", () => {
  const environmentId = EnvironmentId.make("env-a");
  const hold = {
    branch: "feature",
    environmentId,
    checkouts: [{ cwd: "/repo", replaces: "main" }],
  };
  const current = { canonicalBranch: "main", environmentId, cwd: "/repo" };

  it("keeps showing the checked-out branch while status still reports the old one", () => {
    expect(isBranchHoldCurrent(hold, current)).toBe(true);
  });

  it("lets go once status moves, even to a different branch than the checkout", () => {
    for (const canonicalBranch of ["feature", "other", null]) {
      expect(isBranchHoldCurrent(hold, { ...current, canonicalBranch })).toBe(false);
    }
  });

  it("does not apply to another checkout that happens to be on the old branch", () => {
    expect(isBranchHoldCurrent(hold, { ...current, cwd: "/other" })).toBe(false);
  });

  it("follows a thread moving from its worktree to the project root", () => {
    const moveHold = {
      branch: "main",
      environmentId,
      checkouts: [
        { cwd: "/repo-feature", replaces: "feature" },
        { cwd: "/repo", replaces: "dev" },
      ],
    };
    expect(
      isBranchHoldCurrent(moveHold, {
        environmentId,
        cwd: "/repo-feature",
        canonicalBranch: "feature",
      }),
    ).toBe(true);
    expect(
      isBranchHoldCurrent(moveHold, { environmentId, cwd: "/repo", canonicalBranch: "dev" }),
    ).toBe(true);
    expect(
      isBranchHoldCurrent(moveHold, { environmentId, cwd: "/repo", canonicalBranch: "main" }),
    ).toBe(false);
  });

  it("does not apply to the same path on another environment", () => {
    expect(
      isBranchHoldCurrent(hold, { ...current, environmentId: EnvironmentId.make("env-b") }),
    ).toBe(false);
  });
});
