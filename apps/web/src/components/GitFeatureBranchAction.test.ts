import { assert, it } from "vite-plus/test";
import { resolveFeatureBranchUnavailableReason } from "./GitActionsControl.logic";

it("only offers an automatic feature branch when the action commits changes", () => {
  const context = { branchName: "main", hasWorkingTreeChanges: true };
  for (const action of ["push", "create_pr"] as const) {
    assert.include(
      resolveFeatureBranchUnavailableReason({ ...context, action }) ?? "",
      "doesn't commit",
    );
  }
  assert.isNull(resolveFeatureBranchUnavailableReason({ ...context, action: "commit_push" }));
});
