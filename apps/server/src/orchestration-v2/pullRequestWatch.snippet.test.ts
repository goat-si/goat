import {
  type PullRequestCheck,
  type PullRequestComment,
  PullRequestWatchPolicy,
  type ThreadPullRequestWatch,
} from "@goat/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { evaluatePullRequestWatch, pullRequestWatchOutcome } from "./pullRequestWatch.ts";

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

describe("pull request watch snippet", () => {
  it.each([
    [
      "a bot's leading badge",
      '<a href="https://app.coderabbit.ai/change-stack/o/r/pull/1?cs_source=review_comment"><picture><source media="(prefers-color-scheme: dark)" srcset="https://coderabbit.ai/badge-dark.svg"><img alt="Severity > `Minor`" src="https://coderabbit.ai/badge.svg"></picture></a>\r\n\r\n_⚠️ Potential issue_ | _🟠 Major_\r\n\r\n**Guard the empty list.**',
      "_⚠️ Potential issue_ | _🟠 Major_ **Guard the empty list.**",
    ],
    [
      "tags in prose and a hidden comment",
      "<!-- state -->\n<details>\n<summary>Why</summary>\n\n<p>Guard this</p>, then <br/>retry.\n</details>",
      "Why Guard this , then retry.",
    ],
    [
      "entities in prose but not code",
      "Fish &amp; chips &lt;ready&gt; and `&amp;`.",
      "Fish & chips <ready> and `&amp;`.",
    ],
    [
      "type arguments",
      "Return Promise<void>, not Promise<A> or Vec<code>.",
      "Return Promise<void>, not Promise<A> or Vec<code>.",
    ],
    [
      "code spans and fences",
      "Replace `<div>` with ``<span>``:\n~~~html\n<p>Done</p>\n~~~\r\nor\r\n```html\r\n<b>Done</b>\r\n```",
      "Replace `<div>` with ``<span>``: ~~~html <p>Done</p> ~~~ or ```html <b>Done</b> ```",
    ],
    [
      "indented code",
      "Use this replacement:\n\n    <div>\n      <span>Ready</span>\n    </div>\n\nKeep the <b>wrapper</b>.",
      "Use this replacement: <div> <span>Ready</span> </div> Keep the wrapper .",
    ],
    ["an indented continuation of an HTML block", "<div>\n    <span>Ready</span>\n</div>", "Ready"],
  ])("quotes a remark's text without its HTML tags: %s", (_name, body, quoted) => {
    const report = evaluate(watch(), detail(), [remark("reviewer", "2026-10-02T12:06:00Z", body)]);
    const wake = pullRequestWatchOutcome({
      number: 1,
      url: "https://github.com/o/r/pull/1",
      baseBranch: "main",
      report,
    }).wake;
    assert.isDefined(wake);
    assert.include(wake!.text, `: "${quoted}" `);
  });
});
