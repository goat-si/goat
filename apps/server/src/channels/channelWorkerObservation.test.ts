import { assert, describe, it } from "@effect/vitest";
import {
  type ChannelTaskNeedsYou,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
  ProviderThreadId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  ThreadPullRequestLink,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  completionHoldCount,
  newApprovals,
  needsYouFromRuntimeRequests,
  observesUsageLimit,
  pullRequestsFromLinks,
  SUBAGENT_DEPTH,
  SUBAGENT_THREADS,
  scanSubagents,
  subagentRequests,
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
) => ({
  id: RuntimeRequestId.make("request:" + kind + ":" + status + ":" + at),
  kind,
  status,
  createdAt: DateTime.makeUnsafe(at),
});

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

  it("names the request and thread of an approval only when asked to", () => {
    const worker = ThreadId.make("thread:worker");
    const pending = request("command");
    const named = needsYouFromRuntimeRequests([pending, request("user_input")], () => worker);
    assert.deepStrictEqual(named, [
      {
        kind: "approval",
        since: "2026-10-17T09:30:00.000Z",
        approval: { requestId: pending.id, threadId: worker },
      },
      { kind: "question", since: "2026-10-17T09:30:00.000Z" },
    ]);
    // Only approvals not listed before get a card.
    const later = request("file-change", "pending", "2026-10-17T09:40:00.000Z");
    const next = needsYouFromRuntimeRequests([pending, later], () => worker);
    assert.deepStrictEqual(newApprovals(named, next), [{ requestId: later.id, threadId: worker }]);
    assert.deepStrictEqual(newApprovals(next, next), []);
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

describe("subagentRequests", () => {
  const request = (id: string) =>
    ({ id, kind: "command", status: "pending", createdAt: NOW }) as never;
  const child = (
    childThreadId: string | null,
    status: OrchestrationV2Subagent["status"] = "running",
    extra: Partial<OrchestrationV2Subagent> = {},
  ) =>
    ({
      childThreadId,
      status,
      origin: "app_owned",
      ...extra,
    }) as unknown as OrchestrationV2Subagent;

  it.effect("reads each live local child once, skipping remote, promoted and ended ones", () =>
    Effect.gen(function* () {
      const reads: Array<string> = [];
      const tree: Record<
        string,
        { runtimeRequests: never[]; subagents: OrchestrationV2Subagent[] }
      > = {
        a: { runtimeRequests: [request("a")], subagents: [child("b"), child("a")] },
        b: { runtimeRequests: [request("b")], subagents: [] },
      };
      const found = yield* subagentRequests(
        [
          child("a"),
          child("a"),
          child(null, "running", { remote: { host: "mini" } as never }),
          child("promoted", "running", { promotedAt: NOW }),
          child("done", "completed"),
        ],
        (threadId) =>
          Effect.sync(() => {
            reads.push(threadId);
            return tree[threadId]!;
          }),
      );
      assert.deepStrictEqual(reads, ["a", "b"]);
      assert.deepStrictEqual(
        found.map((item) => (item as unknown as { id: string }).id),
        ["a", "b"],
      );
    }),
  );

  it.effect("stops at the depth and thread limits", () =>
    Effect.gen(function* () {
      const reads: Array<string> = [];
      const wide = Array.from({ length: SUBAGENT_THREADS + 5 }, (_, index) => child("t" + index));
      yield* subagentRequests(wide, (threadId) =>
        Effect.sync(() => {
          reads.push(threadId);
          return { runtimeRequests: [], subagents: [child(threadId + "-deeper")] };
        }),
      );
      assert.strictEqual(reads.length, SUBAGENT_THREADS);
      const deep: Array<string> = [];
      yield* subagentRequests([child("d0")], (threadId) =>
        Effect.sync(() => {
          deep.push(threadId);
          return { runtimeRequests: [], subagents: [child(threadId + "x")] };
        }),
      );
      assert.strictEqual(deep.length, SUBAGENT_DEPTH);
    }),
  );

  it.effect("counts a live remote subagent toward the cap and skips a cloud child", () =>
    Effect.gen(function* () {
      const reads: Array<string> = [];
      const remote = (id: string) =>
        child(null, "running", {
          remote: { host: "mini", threadId: null, correlationId: id },
        });
      const full = Array.from({ length: SUBAGENT_THREADS }, (_, index) => remote("r" + index));
      const blocked = yield* scanSubagents([...full, child("local")], (threadId) =>
        Effect.sync(() => {
          reads.push(threadId);
          return { runtimeRequests: [], subagents: [] };
        }),
      );
      assert.strictEqual(reads.length, 0);
      assert.strictEqual(blocked.remote.length, SUBAGENT_THREADS);
      const cloud = child(null, "running");
      const admitted = yield* scanSubagents(
        [...full.slice(0, SUBAGENT_THREADS - 1), cloud, child("local")],
        (threadId) =>
          Effect.sync(() => {
            reads.push(threadId);
            return { runtimeRequests: [request("local")], subagents: [] };
          }),
      );
      assert.deepStrictEqual(reads, ["local"]);
      assert.strictEqual(admitted.remote.length, SUBAGENT_THREADS - 1);
      assert.deepStrictEqual(
        admitted.requests.map((item) => item.threadId),
        ["local"],
      );
    }),
  );
});
