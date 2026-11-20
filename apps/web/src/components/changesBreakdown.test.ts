import type { VcsStatusResult } from "@goat/contracts";
import { expect, it } from "vite-plus/test";
import { resolveChangesTotals } from "./GitActionsControl.logic.ts";

it("returns a category breakdown only when file stats match the selected totals", () => {
  const status: VcsStatusResult = {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "feature",
    hasWorkingTreeChanges: true,
    workingTree: {
      files: [
        { path: "src/a.ts", insertions: 3, deletions: 1 },
        { path: "src/a.test.ts", insertions: 2, deletions: 0 },
      ],
      insertions: 5,
      deletions: 1,
    },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
  };
  const totals = resolveChangesTotals(status, null, true);
  expect(totals && Reflect.get(totals, "breakdown")).toMatchObject({
    code: { additions: 3, deletions: 1 },
    tests: { additions: 2, deletions: 0 },
  });
  const incomplete = { ...status, workingTree: { ...status.workingTree, insertions: 6 } };
  const missing = resolveChangesTotals(incomplete, null, true);
  expect(missing && Reflect.get(missing, "breakdown")).toBeNull();
  const branch = resolveChangesTotals(
    { ...status, branchChanges: { baseRef: "main", insertions: 20, deletions: 3 } },
    null,
    true,
  );
  expect(branch && Reflect.get(branch, "breakdown")).toBeNull();
  const source = {
    id: "branch-range",
    kind: "branch-range",
    title: "Changes",
    baseRef: "main",
    headRef: "feature",
    diff: "",
    diffHash: "hash",
    truncated: false,
    files: [{ path: "README.md", previousPath: null, additions: 4, deletions: 0 }],
  } as const;
  const preview = resolveChangesTotals(status, source, true);
  expect(preview && Reflect.get(preview, "breakdown")).toMatchObject({
    docs: { additions: 4, deletions: 0 },
  });
  const truncated = resolveChangesTotals(status, { ...source, truncated: true }, true);
  expect(truncated && Reflect.get(truncated, "breakdown")).toBeNull();
});
