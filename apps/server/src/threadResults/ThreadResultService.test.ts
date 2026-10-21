import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { assert, it } from "@effect/vitest";
import { RunId, ThreadId, type OrchestrationV2Run } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadResultService from "./ThreadResultService.ts";

const threadId = ThreadId.make("thread-result");
const firstRun = RunId.make("run-1");
const secondRun = RunId.make("run-2");

const thread = {
  id: threadId,
  branch: "feat/result",
  linkedPullRequest: null,
  pullRequests: [
    {
      host: "github.com",
      repository: "goat-si/goat",
      number: 7,
      url: "https://github.com/goat-si/goat/pull/7",
      source: "created",
      linkedAt: "2026-10-13T00:00:00.000Z",
      snapshot: { state: "open" },
      stack: null,
    },
    {
      host: "github.com",
      repository: "goat-si/goat",
      number: 8,
      url: "https://github.com/goat-si/goat/pull/8",
      source: "stack-dismissed",
      linkedAt: "2026-10-13T00:00:00.000Z",
      snapshot: null,
      stack: null,
    },
  ],
} as never;

const run = (id: RunId, ordinal: number, status: OrchestrationV2Run["status"]) =>
  ({ id, ordinal, status }) as OrchestrationV2Run;

const layerWithRuns = (runs: ReadonlyArray<OrchestrationV2Run>) =>
  ThreadResultService.layer.pipe(
    Layer.provide(
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadRecords: () => Effect.succeed({ thread, runs } as never),
      }),
    ),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );

it("derives only failed and cancelled outcomes from an unreported run", () => {
  const result = (status: OrchestrationV2Run["status"]) =>
    ThreadResultService.buildThreadResult({ thread, run: run(firstRun, 1, status), stored: null })
      .outcome;
  assert.strictEqual(result("completed"), null);
  assert.strictEqual(result("running"), null);
  assert.strictEqual(result("failed"), "failed");
  assert.strictEqual(result("interrupted"), "cancelled");
});

it("merges reported pull requests ahead of linked ones and skips dismissed links", () => {
  const result = ThreadResultService.buildThreadResult({
    thread,
    run: run(firstRun, 1, "completed"),
    stored: {
      reportedAt: "2026-10-13T01:00:00.000Z",
      report: {
        outcome: "succeeded",
        pullRequests: [
          { url: "https://github.com/goat-si/goat/pull/9", number: 9 },
          { url: "https://github.com/goat-si/goat/pull/7", number: 7, state: "merged" },
        ],
      },
    },
  });
  assert.deepStrictEqual(result.pullRequests, [
    { url: "https://github.com/goat-si/goat/pull/9", number: 9 },
    { url: "https://github.com/goat-si/goat/pull/7", number: 7, state: "merged" },
  ]);
  assert.strictEqual(result.outcome, "succeeded");
  assert.strictEqual(result.branch, "feat/result");
});

it.effect("stores a report on the live run and reads it back for that run only", () =>
  Effect.gen(function* () {
    const results = yield* ThreadResultService.ThreadResultService;
    const reported = yield* results.report(threadId, {
      outcome: "succeeded",
      summary: "Opened the PR.",
      tests: { command: "vp test run", passed: 3, failed: 0, ok: true },
      commits: ["abc1234"],
    });
    assert.strictEqual(reported.runId, secondRun);
    // A second report replaces the first.
    yield* results.report(threadId, { outcome: "blocked", summary: "Needs a token." });

    const latest = yield* results.forRun(threadId);
    assert.strictEqual(latest?.runId, secondRun);
    assert.strictEqual(latest?.outcome, "blocked");
    assert.strictEqual(latest?.summary, "Needs a token.");
    assert.deepStrictEqual(latest?.commits, []);
    assert.isNotNull(latest?.reportedAt);
    assert.deepStrictEqual(latest?.pullRequests, [
      { url: "https://github.com/goat-si/goat/pull/7", number: 7, state: "open" },
    ]);

    const earlier = yield* results.forRun(threadId, firstRun);
    assert.strictEqual(earlier?.reportedAt, null);
    assert.strictEqual(earlier?.outcome, null);
    assert.isUndefined(earlier?.observedCheck);

    // GOAT's own check sits beside the reported tests, even when they disagree.
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO thread_run_observed_checks
        (thread_id, run_id, status, command, exit_code, duration_ms, started_at)
      VALUES (${threadId}, ${secondRun}, 'completed', 'vp test run', 1, 900,
        '2026-10-13T02:00:00.000Z')
    `;
    const checked = yield* results.report(threadId, {
      outcome: "succeeded",
      tests: { command: "vp test run", passed: 3, failed: 0, ok: true },
    });
    assert.strictEqual(checked.tests?.ok, true);
    assert.deepStrictEqual(checked?.observedCheck, {
      status: "completed",
      command: "vp test run",
      exitCode: 1,
      durationMs: 900,
      at: "2026-10-13T02:00:00.000Z",
    });
    assert.deepStrictEqual((yield* results.forRun(threadId))?.observedCheck, checked.observedCheck);
  }).pipe(
    Effect.provide(layerWithRuns([run(firstRun, 1, "completed"), run(secondRun, 2, "running")])),
  ),
);

it.effect("refuses a report from a thread without runs", () =>
  Effect.gen(function* () {
    const results = yield* ThreadResultService.ThreadResultService;
    const error = yield* Effect.flip(results.report(threadId, { outcome: "succeeded" }));
    assert.strictEqual(error.reason, "run_not_found");
    assert.isNull(yield* results.forRun(threadId));
  }).pipe(Effect.provide(layerWithRuns([]))),
);

it.effect("publishes a result report only after it is durable", () =>
  Effect.gen(function* () {
    const results = yield* ThreadResultService.ThreadResultService;
    const changes = yield* results.subscribeReports;
    const received = yield* changes.pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped);
    yield* results.report(threadId, { outcome: "succeeded" });
    assert.deepStrictEqual(yield* Fiber.join(received), [threadId]);
    assert.strictEqual((yield* results.forRun(threadId))?.outcome, "succeeded");
  }).pipe(Effect.provide(layerWithRuns([run(firstRun, 1, "completed")]))),
);
