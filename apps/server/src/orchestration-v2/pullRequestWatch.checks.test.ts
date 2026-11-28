import {
  type PullRequestCheck,
  type ThreadPullRequestWatch,
  PullRequestWatchPolicy,
} from "@goat/contracts";
import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { evaluatePullRequestWatch } from "./pullRequestWatch.ts";
const STARTED = "2026-10-02T12:00:00.000Z";

const watch = (overrides: Partial<ThreadPullRequestWatch> = {}): ThreadPullRequestWatch => ({
  startedAt: STARTED,
  headSha: null,
  failedChecks: [],
  passed: false,
  passedChecks: [],
  remarksThrough: STARTED,
  remarkIds: [],
  conflicting: false,
  wakes: 0,
  ...overrides,
});

const check = (name: string, status: PullRequestCheck["status"]): PullRequestCheck => ({
  name,
  status,
  description: null,
  url: `https://ci.example/${name}`,
});

type Detail = Parameters<typeof evaluatePullRequestWatch>[1];

const capabilities = (checksAlwaysReport: boolean): Detail["capabilities"] => ({
  diff: true,
  comment: true,
  actions: [],
  mergeMethods: [],
  search: false,
  review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
  reviewers: { request: false, listCandidates: false },
  checksAlwaysReport,
});

const detail = (overrides: Partial<Detail> = {}): Detail => ({
  capabilities: capabilities(true),
  headSha: "aaaaaaaaaa",
  checks: [check("lint", "success"), check("test", "pending")],
  mergeability: "mergeable",
  viewer: "agent-user",
  author: { login: "agent-user", name: null, avatarUrl: null },
  ...overrides,
});

const noRemarks = [];
const DEFAULT_POLICY = Schema.decodeSync(PullRequestWatchPolicy)({});
/** Everything wakes, so the comparison rules are tested apart from the policy. */
const REACT_ALL: PullRequestWatchPolicy = {
  ...DEFAULT_POLICY,
  botRemarks: "react",
  conflictMaxIdleDays: null,
};
const context = (policy: PullRequestWatchPolicy = REACT_ALL, idleMs = 0) => ({
  policy,
  threadActiveAt: Date.parse(STARTED) - idleMs,
  now: Date.parse(STARTED),
});
type Args = Parameters<typeof evaluatePullRequestWatch>;
const evaluate = (
  current: Args[0],
  pullRequest: Args[1],
  remarks: Args[2],
  options: Args[3] = context(),
) => evaluatePullRequestWatch(current, pullRequest, remarks, options);

it("reports a newly passed check once when none is required", () => {
  const first = evaluate(watch(), detail({ checks: [check("test", "success")] }), noRemarks);
  assert.deepEqual(first.changes, [{ kind: "checks-passed", count: 1, required: false }]);
  const both = detail({ checks: [check("test", "success"), check("e2e", "success")] });
  const second = evaluate(first.next, both, noRemarks);
  assert.deepEqual(second.changes, [{ kind: "checks-passed", count: 2, required: false }]);
  // regression: #16208 a check list that varies between reads must not wake again and again
  const flipped = evaluate(second.next, detail({ checks: [check("test", "success")] }), noRemarks);
  assert.deepEqual(flipped.changes, []);
  assert.deepEqual(evaluate(flipped.next, both, noRemarks).changes, []);

  // Advisory names told earlier do not hide a check that later turns required.
  const required = (name: string) => ({ ...check(name, "success"), required: true });
  const promoted = evaluate(
    second.next,
    detail({ checks: [required("test"), check("e2e", "success")] }),
    noRemarks,
  );
  assert.deepEqual(promoted.changes, []);
  const gated = detail({
    checks: [required("test"), required("e2e"), check("deploy", "pending")],
  });
  assert.deepEqual(evaluate(promoted.next, gated, noRemarks).changes, [
    { kind: "checks-passed", count: 2, required: true },
  ]);
});
