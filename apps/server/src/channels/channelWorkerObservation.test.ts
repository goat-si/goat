import { assert, describe, it } from "@effect/vitest";
import {
  type ChannelTaskNeedsYou,
  type OrchestrationV2RuntimeRequest,
  ProviderThreadId,
  RunId,
  ThreadPullRequestLink,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import {
  completionHoldCount,
  needsYouFromRuntimeRequests,
  observesUsageLimit,
  pullRequestsFromLinks,
  usageLimitWait,
} from "./channelWorkerObservation.ts";

const NOW = DateTime.makeUnsafe("2026-10-17T10:00:00.000Z");
const decodeLink = Schema.decodeUnknownSync(ThreadPullRequestLink);

const link = (number: number, overrides: Record<string, unknown> = {}) =>
  decodeLink({
    host: "github.com",
    repository: "goat-si/goat",
    number,
    url: `https://github.com/goat-si/goat/pull/${number}`,
    source: "agent",
    linkedAt: "2026-10-17T09:00:00.000Z",
    snapshot: null,
    stack: null,
    ...overrides,
  });

const watch = {
  startedAt: "2026-10-17T09:00:00.000Z",
  headSha: null,
  failedChecks: [],
  passed: false,
  passedChecks: [],
  remarksThrough: "2026-10-17T09:00:00.000Z",
  remarkIds: [],
  conflicting: false,
  wakes: 0,
};

const request = (
  kind: OrchestrationV2RuntimeRequest["kind"],
  status: OrchestrationV2RuntimeRequest["status"] = "pending",
  at = "2026-10-17T09:30:00.000Z",
) => ({ kind, status, createdAt: DateTime.makeUnsafe(at) });

const completedRun = { id: RunId.make("run-1"), ordinal: 1, status: "completed" as const };

describe("needsYouFromRuntimeRequests", () => {
  it("names pending requests a person must answer and skips everything else", () => {
    assert.deepStrictEqual(
      needsYouFromRuntimeRequests([
        request("command", "pending", "2026-10-17T09:31:00.000Z"),
        request("user_input"),
        request("auth_refresh"),
        request("dynamic_tool_call"),
        request("file-change", "resolved"),
      ]),
      [
        { kind: "question", since: "2026-10-17T09:30:00.000Z" },
        { kind: "sign_in", since: "2026-10-17T09:30:00.000Z" },
        { kind: "approval", since: "2026-10-17T09:31:00.000Z" },
      ],
    );
  });
});

describe("pullRequestsFromLinks", () => {
  it("copies visible links in a stable order with their state and watch", () => {
    const merged = link(7, {
      snapshot: {
        state: "merged",
        title: "Fix",
        headBranch: "fix",
        baseBranch: "dev",
        isDraft: false,
        updatedAt: null,
        syncedAt: "2026-10-17T09:10:00.000Z",
      },
    });
    assert.deepStrictEqual(
      pullRequestsFromLinks([link(9, { watch }), merged, link(8, { source: "stack-dismissed" })]),
      [
        {
          repository: "goat-si/goat",
          number: 7,
          url: "https://github.com/goat-si/goat/pull/7",
          state: "merged",
          watching: false,
        },
        {
          repository: "goat-si/goat",
          number: 9,
          url: "https://github.com/goat-si/goat/pull/9",
          watching: true,
        },
      ],
    );
  });
});

describe("completionHoldCount", () => {
  const hold = (
    pullRequests: ReadonlyArray<ThreadPullRequestLink>,
    pendingBackgroundTasks: ReadonlyArray<{ taskId: string; kind: "subagent" }> = [],
  ) =>
    completionHoldCount({
      current: completedRun,
      runs: [completedRun],
      providerThreads: [{ id: ProviderThreadId.make("provider-thread"), pendingBackgroundTasks }],
      pullRequests,
    });

  it("holds a completed run while a pull request is watched or background work runs", () => {
    assert.strictEqual(hold([link(1)]), 0);
    assert.strictEqual(hold([link(1, { watch })]), 1);
    assert.strictEqual(hold([], [{ taskId: "bg", kind: "subagent" }]), 1);
    assert.strictEqual(hold([link(1, { watch, source: "stack-dismissed" })]), 0);
  });
});

describe("usageLimitWait", () => {
  type Shell = NonNullable<Parameters<typeof usageLimitWait>[0]>;
  const run = {
    id: RunId.make("run-1"),
    completedAt: DateTime.makeUnsafe("2026-10-17T09:45:00.000Z"),
  };
  const shell = (overrides: Partial<Shell> = {}): Shell => ({
    lastErrorClass: "usage_limit",
    latestRunId: RunId.make("run-1"),
    usageLimitResetAt: "2026-10-17T12:00:00.000Z",
    limitRecovery: null,
    ...overrides,
  });
  const needsYou: ChannelTaskNeedsYou = {
    kind: "usage_limit",
    since: "2026-10-17T09:45:00.000Z",
  };

  it("ignores other failures and older runs", () => {
    assert.isUndefined(usageLimitWait(shell({ lastErrorClass: "provider_error" }), run, NOW));
    assert.isUndefined(usageLimitWait(shell({ latestRunId: RunId.make("run-0") }), run, NOW));
    assert.isUndefined(usageLimitWait(null, run, NOW));
  });

  it("offers to arm automatic resume for a reset ahead with no choice made", () => {
    assert.deepStrictEqual(usageLimitWait(shell(), run, NOW), {
      resetAt: "2026-10-17T12:00:00.000Z",
      needsYou,
      arm: { resetAt: "2026-10-17T12:00:00.000Z", resetMs: Date.parse("2026-10-17T12:00:00.000Z") },
    });
  });

  it("waits once automatic resume is chosen, even past the reset", () => {
    const recovery = {
      runId: RunId.make("run-1"),
      resetAt: "2026-10-17T09:50:00.000Z",
      autoResume: true,
    };
    assert.deepStrictEqual(
      usageLimitWait(
        shell({ usageLimitResetAt: "2026-10-17T09:50:00.000Z", limitRecovery: recovery }),
        run,
        NOW,
      ),
      { resetAt: "2026-10-17T09:50:00.000Z" },
    );
  });

  it("needs a person when resume was turned off or the reset is unknown", () => {
    const declined = {
      runId: RunId.make("run-1"),
      resetAt: "2026-10-17T12:00:00.000Z",
      autoResume: false,
    };
    assert.deepStrictEqual(usageLimitWait(shell({ limitRecovery: declined }), run, NOW), {
      resetAt: "2026-10-17T12:00:00.000Z",
      needsYou,
    });
    assert.deepStrictEqual(usageLimitWait(shell({ usageLimitResetAt: null }), run, NOW), {
      needsYou,
    });
  });

  it("reads an observation as paused on a usage limit", () => {
    assert.isTrue(observesUsageLimit({ pullRequests: [], needsYou: [], usageLimitResetAt: "x" }));
    assert.isTrue(
      observesUsageLimit({ pullRequests: [], needsYou: [{ kind: "usage_limit", since: "x" }] }),
    );
    assert.isFalse(
      observesUsageLimit({ pullRequests: [], needsYou: [{ kind: "approval", since: "x" }] }),
    );
    assert.isFalse(observesUsageLimit(undefined));
  });
});
