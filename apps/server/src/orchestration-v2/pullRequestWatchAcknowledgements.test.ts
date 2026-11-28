import {
  type PullRequestCheck,
  type PullRequestComment,
  PullRequestWatchPolicy,
  type ThreadPullRequestWatch,
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

const codeRabbitReply = (status: string, action = "Action performed") =>
  `<!-- coderabbit-ai-generated:v1 -->

<!-- This is an auto-generated reply by CodeRabbit -->
<!-- CodeRabbit review command invocation: test -->
<details>
<summary>${action}</summary>
<dl>
<dd>
<br>

${status}

> Note: CodeRabbit is an incremental review system and does not re-review already reviewed commits.

</dd>
</dl>
</details>`;

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

it("skips CodeRabbit review acknowledgements and wakes once for their outcome edits", () => {
  const current = `<!-- This is an auto-generated reply by CodeRabbit -->
<details>
<summary>✅ Actions performed</summary>

Review triggered.

</details>`;
  // GitHub's GraphQL API names bots without the "[bot]" suffix that its REST API adds.
  for (const [login, acknowledgement] of [
    ["coderabbitai[bot]", codeRabbitReply("Review triggered.")],
    ["coderabbitai[bot]", codeRabbitReply("Full review triggered.")],
    ["coderabbitai[bot]", current],
    ["coderabbitai", current],
  ] as const) {
    const queued = {
      ...remark(login, "2026-10-02T12:06:00Z", acknowledgement),
      kind: "issue-comment" as const,
      path: null,
    };
    const watching = watch({ headSha: "aaaaaaaaaa", wakes: 2 });
    const progress = evaluate(watching, detail(), [queued]);
    assert.deepEqual(progress.changes, []);
    assert.equal(progress.next.remarksThrough, queued.createdAt);
    assert.deepEqual(progress.next.remarkIds, [queued.id]);
    assert.equal(progress.next.wakes, 2);
    assert.isFalse(progress.exhausted);
    assert.deepEqual(evaluate(progress.next, detail(), [queued]).changes, []);

    const outcome = {
      ...queued,
      body: codeRabbitReply("Review finished."),
      editedAt: "2026-10-02T12:07:00Z",
    };
    const finished = evaluate(progress.next, detail(), [outcome]);
    assert.deepEqual(finished.changes, [{ kind: "remarks", remarks: [outcome] }]);
    assert.equal(finished.next.wakes, 3);
    assert.deepEqual(evaluate(finished.next, detail(), [outcome]).changes, []);

    const late = remark("reviewer", queued.createdAt);
    const mixed = evaluate(watching, detail(), [queued, late]);
    assert.deepEqual(mixed.changes, [{ kind: "remarks", remarks: [late] }]);
    assert.deepEqual(mixed.next.remarkIds, [queued.id, late.id]);
  }
});

it("keeps other replies and outcomes actionable beside CodeRabbit review progress", () => {
  const bodies = [
    codeRabbitReply("Full review triggered.", "Actions performed"),
    codeRabbitReply("Unable to review.", "Action not completed"),
    codeRabbitReply("Here is the answer to your question."),
    "Review triggered.",
    codeRabbitReply("Review triggered.").replace(
      "<!-- This is an auto-generated reply by CodeRabbit -->",
      "",
    ),
  ];
  const comments = [
    ...bodies.map((body, index) => ({
      ...remark("coderabbitai[bot]", "2026-10-02T12:06:00Z", body),
      id: `coderabbit-${index}`,
    })),
    remark("other-bot[bot]", "2026-10-02T12:06:00Z", bodies[0]),
    remark("reviewer", "2026-10-02T12:06:00Z", bodies[0]),
  ];
  const report = evaluate(watch(), detail(), comments);
  assert.deepEqual(report.changes, [{ kind: "remarks", remarks: comments.slice(1) }]);
  assert.deepEqual(evaluate(report.next, detail(), comments).changes, []);
});
