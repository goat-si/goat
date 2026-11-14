import { expect, it } from "vite-plus/test";
import { buildFixFindingsHandoff, buildResolveConflictsPrompt } from "./pullRequestDetail.logic";

const base = {
  number: 42,
  title: "Change",
  url: "https://github.com/goat-si/goat/pull/42",
  headBranch: "feat/page",
  baseBranch: "main",
};
const failingCheck = {
  name: "typecheck",
  status: "failure" as const,
  description: "2 errors",
  url: null,
};

it("claims a prepared checkout only when one was prepared", () => {
  const fix = (inThisThread: boolean) =>
    buildFixFindingsHandoff({
      ...base,
      reviewThreads: [],
      comments: [],
      checks: [failingCheck],
      commentsTruncated: false,
      inThisThread,
    }).prompt;
  const resolve = (inThisThread: boolean) => buildResolveConflictsPrompt({ ...base, inThisThread });
  expect(fix(false)).toContain("prepared checkout");
  expect(resolve(false)).toContain("checkout prepared");
  expect(fix(true)).not.toMatch(/prepared/u);
  expect(resolve(true)).not.toMatch(/prepared/u);
  expect(fix(true)).toContain("switching to it or checking it out first");
  expect(resolve(true)).toContain("switch to it or check it out first");
});
