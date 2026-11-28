import { PullRequestWatchPolicy, type ThreadPullRequestWatch } from "@goat/contracts";
import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { evaluatePullRequestWatch } from "./pullRequestWatch.ts";

const started = "2026-10-02T12:00:00.000Z";
const watch = (overrides: Partial<ThreadPullRequestWatch>): ThreadPullRequestWatch => ({
  startedAt: started,
  headSha: null,
  failedChecks: [],
  passed: false,
  passedChecks: [],
  remarksThrough: started,
  remarkIds: [],
  conflicting: false,
  wakes: 0,
  ...overrides,
});
const check = (name: string, status: "success") => ({ name, status, description: null, url: null });
const detail = (
  overrides: Partial<Parameters<typeof evaluatePullRequestWatch>[1]>,
): Parameters<typeof evaluatePullRequestWatch>[1] => ({
  capabilities: {
    diff: true,
    comment: true,
    actions: [],
    mergeMethods: [],
    search: false,
    review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
    reviewers: { request: false, listCandidates: false },
    checksAlwaysReport: true,
  },
  headSha: "aaaaaaaaaa",
  checks: [],
  mergeability: "mergeable",
  viewer: "agent-user",
  author: { login: "agent-user", name: null, avatarUrl: null },
  ...overrides,
});
const noRemarks = [];
const policy = Schema.decodeSync(PullRequestWatchPolicy)({});
const evaluate = (
  current: Parameters<typeof evaluatePullRequestWatch>[0],
  pr: Parameters<typeof evaluatePullRequestWatch>[1],
  remarks: Parameters<typeof evaluatePullRequestWatch>[2],
) =>
  evaluatePullRequestWatch(current, pr, remarks, {
    policy,
    threadActiveAt: Date.parse(started),
    now: Date.parse(started),
  });

it.each([false, true])(
  "reports CI that settles during registration once (required: %s)",
  (required) => {
    const green = detail({ checks: [{ ...check("test", "success"), required }] });
    for (const awaitingBaseline of ["all", "checks"] as const) {
      const first = evaluate(watch({ awaitingBaseline, checksPending: true }), green, noRemarks);
      assert.deepEqual(first.changes, [{ kind: "checks-passed", count: 1, required }]);
      assert.isFalse(first.next.checksPending);
      assert.deepEqual(evaluate(first.next, green, noRemarks).changes, []);
    }
  },
);
