import type { VcsStatusResult } from "@goat/contracts";
import { assert, it } from "vite-plus/test";
import { buildMenuItems, getMenuActionDisabledReason } from "./GitActionsControl.logic";

it("reports the actual push blocker when the working tree is dirty", () => {
  const status: VcsStatusResult = {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "topic",
    hasWorkingTreeChanges: true,
    workingTree: { files: [], insertions: 0, deletions: 0 },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
  };
  const reason = (value: VcsStatusResult) => {
    const item = buildMenuItems(value, false).find((entry) => entry.id === "push");
    assert.isDefined(item);
    return getMenuActionDisabledReason({
      item,
      gitStatus: value,
      isBusy: false,
      hasPrimaryRemote: true,
    });
  };
  assert.equal(reason(status), "No local commits to push.");
  assert.equal(
    reason({ ...status, aheadCount: 1, behindCount: 1 }),
    "Branch is behind upstream. Pull/rebase before pushing.",
  );
});
