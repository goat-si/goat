import { GIT_REVIEW_SCOPES } from "@goat/client-runtime/state/review";
import { environmentRpcKey } from "@goat/client-runtime/state/runtime";
import { EnvironmentId, type ReviewDiffPreviewInput } from "@goat/contracts";
import { expect, it } from "vite-plus/test";

import { gitDiffPreviewInput } from "./gitDiffPreviewInput";

it("gives the Changes totals and the Diff panel's branch view one cache key", () => {
  const key = (input: ReviewDiffPreviewInput) =>
    environmentRpcKey({ environmentId: EnvironmentId.make("env"), input });
  // Argument order differs on purpose: the cache key must not depend on the caller's literal.
  const totals = gitDiffPreviewInput({
    cwd: "/repo",
    scope: "branch-range",
    baseRef: "main",
    ignoreWhitespace: true,
  });
  const panel = gitDiffPreviewInput({
    ignoreWhitespace: true,
    baseRef: "main",
    scope: GIT_REVIEW_SCOPES.branch.sourceKind,
    cwd: "/repo",
  });
  expect(key(panel)).toBe(key(totals));
  expect(
    gitDiffPreviewInput({
      cwd: "/repo",
      scope: "branch-range",
      baseRef: null,
      ignoreWhitespace: false,
    }),
  ).not.toHaveProperty("baseRef");
});
