import {
  type PullRequestCheck,
  type PullRequestComment,
  PullRequestWatchPolicy,
  type ThreadPullRequestWatch,
} from "@goat/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { evaluatePullRequestWatch } from "./pullRequestWatch.ts";

// Upstream 072254ddd3's cases for a watch's first read; the helpers copy pullRequestWatch.test.ts's.
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

const run = (id: number) => `https://github.com/o/r/actions/runs/${id}`;

type Detail = Parameters<typeof evaluatePullRequestWatch>[1];

const detail = (overrides: Partial<Detail> = {}): Detail => ({
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
  checks: [check("lint", "success"), check("test", "pending")],
  mergeability: "mergeable",
  viewer: "agent-user",
  author: { login: "agent-user", name: null, avatarUrl: null },
  ...overrides,
});

const remark = (login: string, createdAt: string): PullRequestComment => ({
  id: `${login}-${createdAt}`,
  kind: "review-comment",
  author: { login, name: null, avatarUrl: null },
  body: "Please rename this.",
  createdAt,
  url: `https://github.com/o/r/pull/1#${login}`,
  path: "src/index.ts",
  reviewState: null,
});

const noRemarks: ReadonlyArray<PullRequestComment> = [];

/** Everything wakes, so the comparison rules are tested apart from the policy. */
const REACT_ALL: PullRequestWatchPolicy = {
  ...Schema.decodeSync(PullRequestWatchPolicy)({}),
  botRemarks: "react",
  conflictMaxIdleDays: null,
};
type Args = Parameters<typeof evaluatePullRequestWatch>;
const evaluate = (
  current: Args[0],
  pullRequest: Args[1],
  remarks: Args[2],
  now = Date.parse(STARTED),
) =>
  evaluatePullRequestWatch(current, pullRequest, remarks, {
    policy: REACT_ALL,
    threadActiveAt: Date.parse(STARTED),
    now,
  });

const anHourLater = (first: ThreadPullRequestWatch, read: Detail) => {
  const kinds: Array<ReadonlyArray<string>> = [];
  let current = first;
  for (let minute = 0; minute <= 60; minute += 10) {
    const { changes, next } = evaluate(current, read, noRemarks, minute * 60_000);
    kinds.push(changes.map((change) => change.kind));
    current = next;
  }
  return kinds;
};

describe("evaluatePullRequestWatch on a watch awaiting its baseline", () => {
  it.each([false, true])("baselines already-passed checks (required: %s)", (required) => {
    const green = detail({ checks: [{ ...check("test", "success"), required }] });
    const baseline = evaluate(watch({ awaitingBaseline: "all" }), green, noRemarks);
    assert.deepEqual(baseline.changes, []);
    assert.equal(baseline.next.headSha, green.headSha);
    assert.isTrue(baseline.next.passed);
    assert.deepEqual(baseline.next.passedChecks, ["test"]);
    assert.isFalse(baseline.exhausted);
    assert.deepEqual(evaluate(baseline.next, green, noRemarks).changes, []);

    const pending = evaluate(
      baseline.next,
      detail({ checks: [{ ...check("test", "pending"), required }] }),
      noRemarks,
    );
    assert.deepEqual(pending.changes, []);
    const failed = evaluate(
      pending.next,
      detail({ checks: [{ ...check("test", "failure"), required }] }),
      noRemarks,
    );
    assert.equal(failed.changes[0]?.kind, "checks-failed");
    const passed = evaluate(failed.next, green, noRemarks);
    assert.deepEqual(passed.changes, [{ kind: "checks-passed", count: 1, required }]);
    assert.deepEqual(
      evaluate(passed.next, { ...green, headSha: "bbbbbbbbbb" }, noRemarks).changes,
      [{ kind: "checks-passed", count: 1, required }],
    );
  });

  it("baselines existing failures and conflicts, then reports new ones", () => {
    const broken = detail({
      checks: [check("lint", "failure"), check("test", "pending")],
      mergeability: "conflicting",
    });
    const baseline = evaluate(watch({ awaitingBaseline: "all" }), broken, noRemarks);
    assert.deepEqual(baseline.changes, []);
    assert.deepEqual(baseline.next.failedChecks, ["lint"]);
    assert.isFalse(baseline.next.passed);
    assert.isTrue(baseline.next.conflicting);
    assert.deepEqual(evaluate(baseline.next, broken, noRemarks).changes, []);

    const failed = evaluate(
      baseline.next,
      { ...broken, checks: [check("lint", "failure"), check("test", "failure")] },
      noRemarks,
    );
    assert.deepEqual(failed.changes, [
      { kind: "checks-failed", failed: [check("test", "failure")] },
    ]);
    const clean = evaluate(failed.next, detail(), noRemarks);
    assert.deepEqual(clean.changes, []);
    assert.deepEqual(evaluate(clean.next, broken, noRemarks).changes, [
      { kind: "checks-failed", failed: [check("lint", "failure")] },
      { kind: "conflicting" },
    ]);
  });

  it("baselines checks already awaiting approval", () => {
    const gated = detail({ checks: [{ ...check("CI", "action-required"), url: run(1) }] });
    const baseline = evaluate(watch({ awaitingBaseline: "all" }), gated, noRemarks);
    assert.deepEqual(baseline.changes, []);
    assert.deepEqual(evaluate(baseline.next, gated, noRemarks).changes, []);
  });

  it("reports remarks after the watch started while baselining checks and conflicts", () => {
    const green = detail({
      checks: [check("test", "success")],
      mergeability: "conflicting",
    });
    const comments = [
      remark("reviewer", "2026-10-02T11:00:00Z"),
      remark("reviewer", "2026-10-02T12:06:00Z"),
    ];
    const baseline = evaluate(watch({ awaitingBaseline: "all" }), green, comments);
    assert.deepEqual(baseline.changes, [{ kind: "remarks", remarks: [comments[1]!] }]);
    assert.isTrue(baseline.next.passed);
    assert.isTrue(baseline.next.conflicting);
    assert.equal(baseline.next.wakes, 1);
    assert.deepEqual(evaluate(baseline.next, green, comments).changes, []);
  });

  it("reports a failure once the head SHA appears after a baseline without one", () => {
    const waiting = evaluate(
      watch({ awaitingBaseline: "all" }),
      detail({ headSha: undefined, checks: [check("test", "pending")] }),
      noRemarks,
    );
    assert.deepEqual(waiting.changes, []);
    const failed = evaluate(
      waiting.next,
      detail({ checks: [check("test", "failure")] }),
      noRemarks,
    );
    assert.deepEqual(failed.changes, [
      { kind: "checks-failed", failed: [check("test", "failure")] },
    ]);
  });

  it("keeps a baseline taken without a head SHA once the SHA appears", () => {
    const green = detail({ checks: [check("test", "success")] });
    const baseline = evaluate(
      watch({ awaitingBaseline: "all" }),
      { ...green, headSha: undefined },
      noRemarks,
    );
    const known = evaluate(baseline.next, green, noRemarks);
    assert.deepEqual(known.changes, []);
    assert.equal(known.next.headSha, green.headSha);
    const unknown = evaluate(known.next, { ...green, headSha: undefined }, noRemarks);
    assert.equal(unknown.next.headSha, green.headSha);
    assert.deepEqual(
      evaluate(unknown.next, { ...green, headSha: "bbbbbbbbbb" }, noRemarks).changes,
      [{ kind: "checks-passed", count: 1, required: false }],
    );
  });

  it.each(["success", "failure"] as const)(
    "reports %s on checks that appear after a first read without any",
    (status) => {
      const empty = evaluate(watch({ awaitingBaseline: "all" }), detail({ checks: [] }), noRemarks);
      assert.deepEqual(empty.changes, []);
      assert.isUndefined(empty.next.awaitingBaseline);
      assert.deepEqual(
        evaluate(empty.next, detail({ checks: [check("test", status)] }), noRemarks).changes,
        status === "success"
          ? [{ kind: "checks-passed", count: 1, required: false }]
          : [{ kind: "checks-failed", failed: [check("test", "failure")] }],
      );
    },
  );

  it("keeps the check baseline through a read whose approval lookup failed", () => {
    const bot = check("bot", "success");
    const unavailable = { ...check("Workflow approval status", "pending"), placeholder: true };
    const partial = evaluate(
      watch({ awaitingBaseline: "all" }),
      detail({ checks: [bot, unavailable] }),
      noRemarks,
    );
    assert.deepEqual(partial.changes, []);
    assert.equal(partial.next.awaitingBaseline, "checks");
    const approval = { ...check("CI", "action-required"), url: run(1) };
    for (const checks of [[bot], [bot, approval]]) {
      assert.deepEqual(evaluate(partial.next, detail({ checks }), noRemarks).changes, []);
    }
  });

  it("reports pending advisory checks finishing after a required-check baseline", () => {
    const initial = detail({
      checks: [{ ...check("test", "success"), required: true }, check("bot", "pending")],
    });
    const baseline = evaluate(watch({ awaitingBaseline: "all" }), initial, noRemarks);
    assert.deepEqual(baseline.changes, []);
    const settled = evaluate(
      baseline.next,
      {
        ...initial,
        checks: [initial.checks[0]!, check("bot", "success")],
      },
      noRemarks,
    );
    assert.deepEqual(settled.changes, [{ kind: "checks-passed", count: 2, required: false }]);
    assert.deepEqual(
      evaluate(
        settled.next,
        {
          ...initial,
          checks: [initial.checks[0]!, check("bot", "success")],
        },
        noRemarks,
      ).changes,
      [],
    );
  });

  it("starts the no-checks clock while a fresh watch awaits its baseline", () => {
    assert.deepEqual(
      anHourLater(watch({ awaitingBaseline: "all" }), detail({ checks: [] })).flat(),
      ["no-checks"],
    );
  });
});
