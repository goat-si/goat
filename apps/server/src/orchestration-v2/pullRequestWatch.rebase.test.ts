import {
  type PullRequestCheck,
  PullRequestWatchPolicy,
  ThreadPullRequestWatch,
} from "@goat/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { evaluatePullRequestWatch, keptAfterPass } from "./pullRequestWatch.ts";

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

const decodeWatch = Schema.decodeUnknownSync(ThreadPullRequestWatch);

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

describe("pull request watch rebase", () => {
  it("reports a required rebase once and preserves it across unknown reads", () => {
    const blocked = { ...detail(), rebaseRequired: true };
    const first = evaluate(watch(), blocked, []);
    assert.include(
      first.changes.map((change) => change.kind),
      "needs-rebase",
    );
    const unknown = evaluate(first.next, { ...blocked, rebaseRequired: undefined }, []);
    assert.notInclude(
      evaluate(unknown.next, blocked, []).changes.map((change) => change.kind),
      "needs-rebase",
    );
    const nullRead = { ...detail() };
    Reflect.set(nullRead, "rebaseRequired", null);
    const stillKnown = evaluate(unknown.next, nullRead, []);
    assert.isTrue(stillKnown.next.rebaseRequired);
    assert.notInclude(
      stillKnown.changes.map((change) => change.kind),
      "needs-rebase",
    );
    const clean = evaluate(unknown.next, { ...blocked, rebaseRequired: false }, []);
    assert.include(
      evaluate(clean.next, blocked, []).changes.map((change) => change.kind),
      "needs-rebase",
    );
  });
  it("decodes an older persisted watch and learns the next successful rebase state", () => {
    const saved = decodeWatch(watch());
    assert.isUndefined(saved.rebaseRequired);
    const fresh = evaluate(saved, { ...detail(), rebaseRequired: true }, []);
    assert.isTrue(fresh.next.rebaseRequired);
    assert.include(
      fresh.changes.map((change) => change.kind),
      "needs-rebase",
    );
    const repeated = evaluate(fresh.next, { ...detail(), rebaseRequired: true }, []);
    assert.notInclude(
      repeated.changes.map((change) => change.kind),
      "needs-rebase",
    );
  });
  it("keeps a rebase as context under the conflict policy and retains it for unknown reads", () => {
    const policy = { ...REACT_ALL, conflicts: "keep_as_context" as const };
    const first = evaluate(watch(), { ...detail(), rebaseRequired: true }, [], context(policy));
    assert.isEmpty(first.changes);
    assert.include(
      first.held.map((change) => change.kind),
      "needs-rebase",
    );
    const kept = keptAfterPass(["requires rebase onto main"], undefined, {
      ...first.next,
      headMoved: false,
    });
    assert.deepEqual(kept, ["requires rebase onto main"]);
    const clean = keptAfterPass(kept, undefined, {
      ...first.next,
      rebaseRequired: false,
      headMoved: false,
    });
    assert.deepEqual(clean, []);
  });
});
