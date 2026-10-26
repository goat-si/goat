import {
  SourceControlProviderKind,
  type PullRequestCheck,
  type PullRequestComment,
  PullRequestWatchPolicy,
  type ThreadPullRequestWatch,
} from "@goat/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  PULL_REQUEST_WATCH_WAKE_LIMIT,
  evaluatePullRequestWatch,
  keptAfterPass,
  mergeHeldContext,
  settleHeldContext,
  pullRequestWatchOutcome,
} from "./pullRequestWatch.ts";

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

const detail = (overrides: Partial<Detail> = {}): Detail => ({
  provider: SourceControlProviderKind.make("github"),
  headSha: "aaaaaaaaaa",
  checks: [check("lint", "success"), check("test", "pending")],
  mergeability: "mergeable",
  viewer: "agent-user",
  author: { login: "agent-user", name: null, avatarUrl: null },
  ...overrides,
});

const remark = (
  login: string,
  createdAt: string,
  body = "Please rename this.",
): PullRequestComment => ({
  id: `${login}-${createdAt}`,
  kind: "review-comment",
  author: { login, name: null, avatarUrl: null },
  body,
  createdAt,
  url: `https://github.com/o/r/pull/1#${login}`,
  path: "src/index.ts",
  reviewState: null,
});

const noRemarks: ReadonlyArray<PullRequestComment> = [];

const DEFAULT_POLICY = Schema.decodeSync(PullRequestWatchPolicy)({});
/** Everything wakes, so the comparison rules are tested apart from the policy. */
const REACT_ALL: PullRequestWatchPolicy = {
  ...DEFAULT_POLICY,
  botRemarks: "react",
  conflictMaxIdleDays: null,
};
const DAY_MS = 24 * 60 * 60_000;
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

describe("evaluatePullRequestWatch", () => {
  it("reports each failure at once, even while another check never finishes", () => {
    const bot = check("CodeRabbit", "pending");
    const first = detail({ checks: [check("lint", "failure"), check("test", "pending"), bot] });
    const lint = evaluate(watch(), first, noRemarks);
    assert.deepEqual(lint.changes, [{ kind: "checks-failed", failed: [check("lint", "failure")] }]);
    assert.deepEqual(evaluate(lint.next, first, noRemarks).changes, []);

    const second = detail({ checks: [check("lint", "failure"), check("test", "failure"), bot] });
    const test = evaluate(lint.next, second, noRemarks);
    assert.deepEqual(test.changes, [{ kind: "checks-failed", failed: [check("test", "failure")] }]);

    // A rerun leaves the list while it runs, so failing again is reported again.
    const rerun = evaluate(test.next, first, noRemarks);
    assert.equal(evaluate(rerun.next, second, noRemarks).changes.length, 1);

    const pushed = detail({ ...second, headSha: "bbbbbbbbbb" });
    assert.equal(evaluate(test.next, pushed, noRemarks).changes.length, 1);
  });

  it("reports passed once the required checks pass, whatever the others do", () => {
    const required = (name: string, status: PullRequestCheck["status"]) => ({
      ...check(name, status),
      required: true,
    });
    const green = detail({
      checks: [required("test", "success"), required("lint", "success"), check("bot", "pending")],
    });
    const passed = evaluate(watch(), green, noRemarks);
    assert.deepEqual(passed.changes, [{ kind: "checks-passed", count: 2, required: true }]);
    assert.deepEqual(evaluate(passed.next, green, noRemarks).changes, []);

    const plain = detail({ checks: [check("test", "success"), check("bot", "pending")] });
    assert.deepEqual(evaluate(watch(), plain, noRemarks).changes, []);
  });

  it("reports passed again when a required check shows up already passed", () => {
    const required = (name: string, status: PullRequestCheck["status"]) => ({
      ...check(name, status),
      required: true,
    });
    const tests = detail({
      checks: [required("Tests", "success"), check("Smoke Tests", "pending")],
    });
    const first = evaluate(watch(), tests, noRemarks);
    assert.deepEqual(first.changes, [{ kind: "checks-passed", count: 1, required: true }]);

    const gated = detail({
      checks: [
        required("Tests", "success"),
        check("Smoke Tests", "success"),
        required("Smoke Tests Gate", "success"),
      ],
    });
    const second = evaluate(first.next, gated, noRemarks);
    assert.deepEqual(second.changes, [{ kind: "checks-passed", count: 2, required: true }]);
    assert.deepEqual(evaluate(second.next, gated, noRemarks).changes, []);

    const pending = detail({
      checks: [required("Tests", "success"), required("Smoke Tests Gate", "pending")],
    });
    const waiting = evaluate(first.next, pending, noRemarks);
    assert.deepEqual(waiting.changes, []);
    assert.deepEqual(evaluate(waiting.next, gated, noRemarks).changes, [
      { kind: "checks-passed", count: 2, required: true },
    ]);
  });

  // regression: #23712 required checks woke the agent early and the rest finishing never did
  it("wakes again when the other checks finish after the required ones passed", () => {
    const required = (name: string, status: PullRequestCheck["status"]) => ({
      ...check(name, status),
      required: true,
    });
    const early = detail({
      checks: [required("test", "success"), check("e2e", "pending")],
    });
    const first = evaluate(watch(), early, noRemarks);
    assert.deepEqual(first.changes, [{ kind: "checks-passed", count: 1, required: true }]);

    const done = detail({
      checks: [required("test", "success"), check("e2e", "success")],
    });
    const final = evaluate(first.next, done, noRemarks);
    assert.deepEqual(
      final.changes.map((change) => change.kind),
      ["checks-passed"],
    );
    assert.deepEqual(evaluate(final.next, done, noRemarks).changes, []);
    // A later advisory job running and passing is not more news.
    const botPending = detail({ checks: [...done.checks, check("bot", "pending")] });
    const churn = evaluate(final.next, botPending, noRemarks);
    assert.deepEqual(churn.changes, []);
    const botDone = detail({ checks: [...done.checks, check("bot", "success")] });
    assert.deepEqual(evaluate(churn.next, botDone, noRemarks).changes, []);

    // A pending check that turns required on the next read still finishes with one wake.
    const promoted = detail({
      checks: [required("test", "success"), required("e2e", "success")],
    });
    const gated = evaluate(first.next, promoted, noRemarks);
    assert.deepEqual(gated.changes, [{ kind: "checks-passed", count: 2, required: true }]);
    assert.deepEqual(evaluate(gated.next, promoted, noRemarks).changes, []);

    // Nothing else was pending when the required ones passed, so nothing more is owed.
    const green = evaluate(watch(), done, noRemarks);
    assert.deepEqual(green.changes, [{ kind: "checks-passed", count: 1, required: true }]);
    assert.deepEqual(evaluate(green.next, botDone, noRemarks).changes, []);
  });

  it("reports an owed non-required failure once after the required notice", () => {
    const required = { ...check("test", "success"), required: true };
    const early = detail({ checks: [required, check("e2e", "pending")] });
    const first = evaluate(watch(), early, noRemarks);
    assert.deepEqual(first.changes, [{ kind: "checks-passed", count: 1, required: true }]);
    const failed = detail({ checks: [required, check("e2e", "failure")] });
    const failure = evaluate(first.next, failed, noRemarks);
    assert.deepEqual(failure.changes, [
      { kind: "checks-failed", failed: [check("e2e", "failure")] },
    ]);
    const repeated = evaluate(failure.next, failed, noRemarks);
    assert.deepEqual(repeated.changes, []);
    const recovered = detail({ checks: [required, check("e2e", "success")] });
    const final = evaluate(repeated.next, recovered, noRemarks);
    assert.deepEqual(final.changes, [{ kind: "checks-passed", count: 2, required: false }]);
    assert.deepEqual(evaluate(final.next, recovered, noRemarks).changes, []);
  });

  it("clears old-head owed checks when a new head is pushed", () => {
    const required = { ...check("test", "success"), required: true };
    const early = detail({ checks: [required, check("e2e", "pending")] });
    const first = evaluate(watch(), early, noRemarks);
    assert.deepEqual(first.next.owedChecks, ["e2e"]);
    const unreadHead = detail({ headSha: "bbbbbbbbbb", checks: [] });
    const unread = evaluate(first.next, unreadHead, noRemarks);
    assert.deepEqual(unread.changes, []);
    assert.deepEqual(unread.next.owedChecks, []);
    const pushed = detail({ ...unreadHead, checks: [required] });
    const newHead = evaluate(unread.next, pushed, noRemarks);
    assert.deepEqual(newHead.changes, [{ kind: "checks-passed", count: 1, required: true }]);
    assert.deepEqual(newHead.next.owedChecks, []);
    const lateResult = detail({ ...pushed, checks: [required, check("e2e", "success")] });
    const final = evaluate(newHead.next, lateResult, noRemarks);
    assert.deepEqual(final.changes, []);
    assert.deepEqual(evaluate(final.next, lateResult, noRemarks).changes, []);
  });

  it("does not report passed again for a new passed check where none is required", () => {
    const first = evaluate(watch(), detail({ checks: [check("test", "success")] }), noRemarks);
    assert.deepEqual(first.changes, [{ kind: "checks-passed", count: 1, required: false }]);
    const both = detail({ checks: [check("test", "success"), check("lint", "success")] });
    assert.deepEqual(evaluate(first.next, both, noRemarks).changes, []);
  });

  it("does not wake a watch saved before passed checks were recorded", () => {
    const green = detail({ checks: [{ ...check("test", "success"), required: true }] });
    const told = watch({ headSha: "aaaaaaaaaa", passed: true });
    const saved = evaluate(told, green, noRemarks);
    assert.deepEqual(saved.changes, []);
    assert.deepEqual(saved.next.passedChecks, ["test"]);
  });

  it("keeps remarks for a later pass when the conversation was not read whole", () => {
    const comments = [remark("reviewer", "2026-10-02T12:06:00Z")];
    const partial = evaluate(watch(), detail(), null);
    assert.deepEqual(partial.changes, []);
    assert.equal(evaluate(partial.next, detail(), comments).changes[0]?.kind, "remarks");
  });

  it("reports a remark that shows up late with the same time as a reported one", () => {
    const first = remark("reviewer", "2026-10-02T12:06:00Z");
    const late = { ...remark("bot", "2026-10-02T12:06:00Z"), id: "late" };
    const reported = evaluate(watch(), detail(), [first]);
    const again = evaluate(reported.next, detail(), [first, late]);
    assert.deepEqual(again.changes, [{ kind: "remarks", remarks: [late] }]);
    assert.deepEqual(again.next.remarkIds, [first.id, "late"]);
  });

  it("reports edits after the watermark once and counts them toward the wake limit", () => {
    const old = remark("greptile[bot]", "2026-10-02T11:00:00Z");
    const watching = watch({
      headSha: "aaaaaaaaaa",
      remarkIds: [old.id],
      wakes: PULL_REQUEST_WATCH_WAKE_LIMIT - 1,
    });
    assert.deepEqual(evaluate(watching, detail(), [old]).changes, []);
    const edited = { ...old, editedAt: "2026-10-02T12:06:00Z" };
    const report = evaluate(watching, detail(), [edited]);
    assert.deepEqual(report.changes, [{ kind: "remarks", remarks: [edited] }]);
    assert.equal(report.next.remarksThrough, edited.editedAt);
    assert.deepEqual(report.next.remarkIds, [old.id]);
    assert.isTrue(report.exhausted);
    assert.deepEqual(evaluate(report.next, detail(), [edited]).changes, []);
    const late = { ...edited, id: "late" };
    assert.deepEqual(evaluate(report.next, detail(), [edited, late]).changes, [
      { kind: "remarks", remarks: [late] },
    ]);
  });

  it("does not treat a failed check read as a rerun", () => {
    const failed = detail({ checks: [check("lint", "failure")] });
    const reported = evaluate(watch(), failed, noRemarks);
    assert.equal(reported.changes.length, 1);
    const unreadable = evaluate(reported.next, detail({ checks: [] }), noRemarks);
    assert.deepEqual(evaluate(unreadable.next, failed, noRemarks).changes, []);
  });

  it("wakes for the pull request's author when the agent is someone else", () => {
    const contributor = detail({ author: { login: "contributor", name: null, avatarUrl: null } });
    const reply = remark("contributor", "2026-10-02T12:06:00Z");
    assert.deepEqual(evaluate(watch(), contributor, [reply]).changes, [
      { kind: "remarks", remarks: [reply] },
    ]);
    const noViewer = detail({ viewer: undefined, author: contributor.author });
    assert.deepEqual(evaluate(watch(), noViewer, [reply]).changes, []);
  });

  it("reports remarks from others once and never the agent's own", () => {
    const comments = [
      remark("agent-user", "2026-10-02T12:05:00Z", "Fixed in the latest push."),
      remark("macroscope-app[bot]", "2026-10-02T12:06:00Z"),
      remark("reviewer", "2026-10-02T11:00:00Z", "Older than the watch."),
    ];
    const report = evaluate(watch(), detail(), comments);
    assert.deepEqual(report.changes, [{ kind: "remarks", remarks: [comments[1]!] }]);
    assert.equal(report.next.remarksThrough, "2026-10-02T12:06:00Z");
    assert.deepEqual(evaluate(report.next, detail(), comments).changes, []);
  });

  it("reports a conflict once, until the branch is clean again", () => {
    const conflicting = detail({ mergeability: "conflicting" });
    const first = evaluate(watch(), conflicting, noRemarks);
    assert.deepEqual(first.changes, [{ kind: "conflicting" }]);
    // GitHub answers "unknown" while it recomputes after a push; that is not a resolution.
    const recomputing = evaluate(first.next, detail({ mergeability: "unknown" }), noRemarks);
    assert.deepEqual(evaluate(recomputing.next, conflicting, noRemarks).changes, []);
    const clean = evaluate(first.next, detail(), noRemarks);
    assert.deepEqual(evaluate(clean.next, conflicting, noRemarks).changes, [
      { kind: "conflicting" },
    ]);
  });

  it("does not spend the comment wake limit on check results", () => {
    const tired = watch({ headSha: "aaaaaaaaaa", wakes: PULL_REQUEST_WATCH_WAKE_LIMIT - 1 });
    const result = evaluate(tired, detail({ checks: [check("lint", "failure")] }), noRemarks);
    assert.isFalse(result.exhausted);
    assert.equal(result.next.wakes, 0);
  });

  it("stops after the wake limit unless the head moves", () => {
    const comments = [remark("reviewer", "2026-10-02T12:10:00Z")];
    const tired = watch({ headSha: "aaaaaaaaaa", wakes: PULL_REQUEST_WATCH_WAKE_LIMIT - 1 });
    assert.isTrue(evaluate(tired, detail(), comments).exhausted);
    const pushed = evaluate(tired, detail({ headSha: "cccccccccc" }), comments);
    assert.isFalse(pushed.exhausted);
    assert.equal(pushed.next.wakes, 1);
  });

  const anHourLater = (
    first: ThreadPullRequestWatch,
    read: Detail,
  ): ReadonlyArray<ReadonlyArray<string>> => {
    const kinds: Array<ReadonlyArray<string>> = [];
    let current = first;
    for (let minute = 0; minute <= 60; minute += 10) {
      const { changes, next } = evaluate(current, read, noRemarks, {
        ...context(),
        now: minute * 60_000,
      });
      kinds.push(changes.map((change) => change.kind));
      current = next;
    }
    return kinds;
  };

  it("does not tell a watch saved before the no-checks clock that its seen head has none", () => {
    // Such a watch may have seen this head's checks pending, which records nothing.
    const legacy = watch({ headSha: "aaaaaaaaaa" });
    assert.isTrue(anHourLater(legacy, detail({ checks: [] })).every((kinds) => kinds.length === 0));
    const pushed = anHourLater(legacy, detail({ headSha: "bbbbbbbbbb", checks: [] }));
    assert.deepEqual(pushed.flat(), ["no-checks"]);
  });

  it("never reports missing checks on a host whose checks it cannot read", () => {
    const azure = detail({
      provider: SourceControlProviderKind.make("azure-devops"),
      checks: [],
    });
    assert.isTrue(anHourLater(watch(), azure).every((kinds) => kinds.length === 0));
  });
});

describe("pull request watch policy", () => {
  const bot = (login: string, createdAt: string, isBot?: boolean): PullRequestComment => {
    const base = remark(login, createdAt, "Preview deployed.");
    return isBot === undefined ? base : { ...base, author: { ...base.author!, isBot } };
  };

  it("does not wake for bots by default, and still moves past their comments", () => {
    const comments = [
      bot("vercel[bot]", "2026-10-02T12:05:00Z"),
      bot("codecov", "2026-10-02T12:06:00Z", true),
    ];
    const report = evaluate(
      watch({ headSha: "aaaaaaaaaa" }),
      detail(),
      comments,
      context(DEFAULT_POLICY),
    );
    assert.deepEqual(report.changes, []);
    assert.deepEqual(report.held, []);
    assert.equal(report.next.wakes, 0);
    assert.equal(report.next.remarksThrough, "2026-10-02T12:06:00Z");
    assert.isFalse(report.exhausted);
  });

  it("treats an allowed bot like a person", () => {
    const policy = { ...DEFAULT_POLICY, allowedBotLogins: ["CodeRabbitAI"] };
    const comments = [
      bot("coderabbitai[bot]", "2026-10-02T12:05:00Z"),
      bot("vercel[bot]", "2026-10-02T12:06:00Z"),
    ];
    const report = evaluate(watch({ headSha: "aaaaaaaaaa" }), detail(), comments, context(policy));
    assert.deepEqual(report.changes, [{ kind: "remarks", remarks: [comments[0]!] }]);
  });

  it("records what is kept as context for the digest instead of the pull request's next wake", () => {
    const policy: PullRequestWatchPolicy = { ...DEFAULT_POLICY, checksPassed: "keep_as_context" };
    const passing = detail({ checks: [check("test", "success")] });
    const quiet = evaluate(watch(), passing, noRemarks, context(policy));
    assert.deepEqual(quiet.changes, []);
    assert.deepEqual(quiet.held, [{ kind: "checks-passed", count: 1, required: false }]);
    const held = pullRequestWatchOutcome({
      number: 7,
      url: "https://github.com/o/r/pull/7",
      baseBranch: "main",
      report: quiet,
    });
    assert.isUndefined(held.wake);
    assert.equal(held.note?.summary, "#7: checks passed, kept as context");
    assert.deepEqual(held.next?.heldContext, ["all 1 check passed on aaaaaaa"]);

    const later = evaluate(
      held.next!,
      passing,
      [remark("reviewer", "2026-10-02T12:10:00Z")],
      context(policy),
    );
    const woken = pullRequestWatchOutcome({
      number: 7,
      url: "https://github.com/o/r/pull/7",
      baseBranch: "main",
      report: later,
    });
    // The next notice turn to start carries it, whichever pull request or lane it is about.
    assert.notInclude(woken.wake?.text ?? "", "all 1 check passed");
    assert.isUndefined(woken.next?.heldContext);
  });

  it("keeps one fragment per kind at its latest state until it is told", () => {
    const merged = mergeHeldContext(
      ["checks failed on aaaaaaa: lint", '1 new comment, latest from bot: "first"'],
      ["all 2 checks passed on bbbbbbb", '2 new comments, latest from bot: "third"'],
    );
    assert.deepEqual(mergeHeldContext(merged, ["conflicts with main"]), [
      "all 2 checks passed on bbbbbbb",
      '3 new comments, latest from bot: "third"',
      "conflicts with main",
    ]);
  });

  it("drops kept context the pull request has moved past", () => {
    const comment = '1 new comment, latest from bot: "ready"';
    const kept = ["conflicts with main", "all 2 checks passed on aaaaaaa", comment];
    const state = { conflicting: true, failedChecks: [], passed: true, headMoved: false };
    assert.deepEqual(settleHeldContext(kept, state), kept);
    // A clean merge clears the conflict; a push makes the old head's checks stale.
    assert.deepEqual(settleHeldContext(kept, { ...state, conflicting: false, headMoved: true }), [
      comment,
    ]);
    // On the same head, failures that cleared no longer hold, nor does a pass a rerun undid.
    const failed = ["checks failed on aaaaaaa: lint", comment];
    assert.deepEqual(settleHeldContext(failed, state), [comment]);
    assert.deepEqual(settleHeldContext(kept, { ...state, passed: false }), [
      "conflicts with main",
      comment,
    ]);
    // A failure fixed while another still fails leaves only the one still failing.
    const both = ["checks failed on aaaaaaa: lint, test"];
    assert.deepEqual(settleHeldContext(both, { ...state, failedChecks: ["test"] }), [
      "checks failed on aaaaaaa: test",
    ]);
    assert.deepEqual(settleHeldContext(both, { ...state, failedChecks: ["lint", "test"] }), both);
  });

  it("keeps a held no-checks note until checks report or the head moves", () => {
    const note = ["no checks reported on aaaaaaa after 15 minutes"];
    const state = { conflicting: false, failedChecks: [], passed: false, headMoved: false };
    assert.deepEqual(settleHeldContext(note, state), note);
    assert.deepEqual(settleHeldContext(note, { ...state, headMoved: true }), []);
    assert.deepEqual(settleHeldContext(note, { ...state, passed: true }), []);
    assert.deepEqual(settleHeldContext(note, { ...state, failedChecks: ["lint"] }), []);
  });

  it("restates kept failures from every check failing after the pass", () => {
    const state = { conflicting: false, passed: false, headMoved: false };
    const six = ["checks failed on aaaaaaa: a, b, c, d, e and 1 more"];
    // The unnamed sixth check recovered; the line no longer counts it.
    assert.deepEqual(
      keptAfterPass(six, [], { ...state, failedChecks: ["a", "b", "c", "d", "e"] }),
      ["checks failed on aaaaaaa: a, b, c, d, e"],
    );
    // A newer failure replaces the fragment, but lint, still failing, stays listed.
    assert.deepEqual(
      keptAfterPass(["checks failed on aaaaaaa: lint"], ["checks failed on aaaaaaa: test"], {
        ...state,
        failedChecks: ["lint", "test"],
      }),
      ["checks failed on aaaaaaa: lint, test"],
    );
  });

  it("hands what a pass kept to the write that ends the watch on its comment limit", () => {
    const policy: PullRequestWatchPolicy = { ...REACT_ALL, botRemarks: "keep_as_context" };
    const report = evaluate(
      watch({ headSha: "aaaaaaaaaa", wakes: PULL_REQUEST_WATCH_WAKE_LIMIT - 1 }),
      detail(),
      [remark("reviewer", "2026-10-02T12:10:00Z"), bot("vercel[bot]", "2026-10-02T12:11:00Z")],
      context(policy),
    );
    const ending = pullRequestWatchOutcome({ number: 7, url: "u", baseBranch: "main", report });
    assert.isNull(ending.next);
    assert.match(
      ending.endedWatch?.heldContext?.[0] ?? "",
      /^1 new comment, latest from vercel\[bot\]/,
    );
    // The ending wake tells it as the orchestrator stores it, merged and settled once.
    assert.notInclude(ending.wake?.text ?? "", "kept as context");
  });

  it("reads context kept before the digest as one fragment per kind", () => {
    const stored = [
      "- Checks failed on aaaaaaa:",
      "  - lint https://ci.example/lint",
      "- The branch now conflicts with main.",
    ];
    assert.deepEqual(mergeHeldContext(stored), [
      "checks failed on aaaaaaa: lint https://ci.example/lint",
      "conflicts with main",
    ]);
    assert.deepEqual(mergeHeldContext(stored, ["all 1 check passed on bbbbbbb"]), [
      "conflicts with main",
      "all 1 check passed on bbbbbbb",
    ]);
  });

  it("names the head of a wake that reports only check results, so a push can drop it", () => {
    const outcome = (remarks: ReadonlyArray<PullRequestComment>) =>
      pullRequestWatchOutcome({
        number: 7,
        url: "https://github.com/o/r/pull/7",
        baseBranch: "main",
        report: evaluate(watch(), detail({ checks: [check("lint", "failure")] }), remarks),
      }).wake;
    assert.equal(outcome(noRemarks)?.checksOn, "aaaaaaaaaa");
    // A comment stays news after a push, so a wake that carries one is kept.
    assert.isUndefined(outcome([remark("reviewer", "2026-10-02T12:10:00Z")])?.checksOn);
  });

  it("names the head of a no-checks wake, so a push drops it", () => {
    const awaited = watch({ headSha: "aaaaaaaaaa", checksAwaitedSince: STARTED });
    const report = evaluate(awaited, detail({ checks: [] }), noRemarks, {
      ...context(),
      now: Date.parse(STARTED) + 20 * 60_000,
    });
    assert.deepEqual(
      report.changes.map((change) => change.kind),
      ["no-checks"],
    );
    const wake = pullRequestWatchOutcome({
      number: 7,
      url: "https://github.com/o/r/pull/7",
      baseBranch: "main",
      report,
    }).wake;
    assert.equal(wake?.checksOn, "aaaaaaaaaa");
  });

  it("drops ignored changes but records them", () => {
    const policy: PullRequestWatchPolicy = { ...DEFAULT_POLICY, checksFailed: "ignore" };
    const report = evaluate(
      watch(),
      detail({ checks: [check("lint", "failure")] }),
      noRemarks,
      context(policy),
    );
    assert.deepEqual(report.changes, []);
    assert.deepEqual(report.next.failedChecks, ["lint"]);
    assert.deepEqual(pullRequestWatchOutcome({ number: 7, url: "u", baseBranch: "main", report }), {
      next: report.next,
    });
  });

  it("lets a conflict wake only a thread active within the idle limit", () => {
    const conflicting = detail({ mergeability: "conflicting" });
    const recent = evaluate(watch(), conflicting, noRemarks, context(DEFAULT_POLICY, 2 * DAY_MS));
    assert.deepEqual(recent.changes, [{ kind: "conflicting" }]);
    const idle = evaluate(watch(), conflicting, noRemarks, context(DEFAULT_POLICY, 4 * DAY_MS));
    assert.deepEqual(idle.changes, []);
    assert.isTrue(idle.next.conflicting);
  });

  it("keeps an automatic watch automatic", () => {
    const report = evaluate(watch({ automatic: true }), detail(), noRemarks);
    assert.isTrue(report.next.automatic);
  });
});
