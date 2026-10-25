import { assert, describe, it } from "@effect/vitest";
import { ProjectId, RunId, ThreadId, type ProjectScript } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import * as AutomationHold from "../automationHold.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ObservedCheckService from "./ObservedCheckService.ts";

const threadId = ThreadId.make("thread-check");
const runId = RunId.make("run-check-1");
const projectId = ProjectId.make("project-check");
const workspaceRoot = "/repo";
const worktreePath = "/repo/.worktrees/feature";

const checkScript = (overrides: Partial<ProjectScript> = {}): ProjectScript => ({
  id: "test",
  name: "Test",
  command: "vp test run",
  icon: "test",
  runOnWorktreeCreate: false,
  runAsCheck: true,
  ...overrides,
});

interface Harness {
  readonly worktreePath: string | null;
  readonly scripts: ReadonlyArray<ProjectScript>;
  readonly worktreeExists?: boolean;
  readonly latestRunId?: RunId;
  readonly activeRunId?: RunId | null;
  readonly runnerFails?: boolean;
  /** Output lines and exit code the fake script produces; undefined never finishes. */
  readonly outcome?: { readonly lines: ReadonlyArray<string>; readonly exitCode: number | null };
}

const makeLayer = (harness: Harness) => {
  const runs: Array<ProjectSetupScriptRunner.ProjectSetupScriptRunnerInput> = [];
  const closed: Array<string> = [];
  const layer = ObservedCheckService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.empty }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadShell: () =>
            Effect.succeed({
              id: threadId,
              projectId,
              worktreePath: harness.worktreePath,
              latestRunId: harness.latestRunId ?? runId,
              activeRunId: harness.activeRunId ?? null,
            } as never),
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeed(
              Option.some({ id: projectId, workspaceRoot, scripts: harness.scripts } as never),
            ),
        }),
        ServerSettings.ServerSettingsService.layerTest(),
        FileSystem.layerNoop({
          exists: () => Effect.succeed(harness.worktreeExists ?? true),
        }),
        Layer.mock(TerminalManager.TerminalManager)({
          close: (input) => Effect.sync(() => void closed.push(input.terminalId ?? "")),
        }),
        Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
          runForThread: (input) =>
            Effect.suspend(() => {
              runs.push(input);
              if (harness.runnerFails) {
                return Effect.fail(
                  new ProjectSetupScriptRunner.ProjectSetupScriptOperationError({
                    threadId,
                    worktreePath: input.worktreePath,
                    operation: "openTerminal",
                    cause: new Error("no pty"),
                  }),
                );
              }
              const outcome = harness.outcome;
              const completion =
                outcome === undefined
                  ? Effect.never
                  : Effect.forEach(
                      outcome.lines,
                      (line) => input.observeCompletion?.onOutputLine?.(line) ?? Effect.void,
                    ).pipe(Effect.as({ exitCode: outcome.exitCode, durationMs: 1_250 }));
              return Effect.succeed({
                status: "started",
                scriptId: "test",
                scriptName: "Test",
                scriptCommand: "vp test run",
                terminalId: "check-test-1",
                cwd: input.cwd ?? input.worktreePath,
                async: true,
                completion,
              } as const);
            }),
        }),
      ),
    ),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );
  return { layer, runs, closed };
};

const observe = Effect.gen(function* () {
  const service = yield* ObservedCheckService.ObservedCheckService;
  yield* service.observeRun(threadId, runId);
  return yield* ObservedCheckService.readObservedCheck(threadId, runId);
});

describe("ObservedCheckService", () => {
  it.effect("held: runs no check when a copied run completes; release: checks run again", () => {
    const harness = makeLayer({
      worktreePath,
      scripts: [checkScript()],
      outcome: { lines: ["ok"], exitCode: 0 },
    });
    return Effect.gen(function* () {
      const hold = yield* AutomationHold.makeInMemory({
        reason: "channel-copy",
        heldAt: "2026-10-25T00:00:00.000Z",
      });
      const held = yield* observe.pipe(Effect.provideService(AutomationHold.AutomationHold, hold));
      assert.isNull(held);
      assert.equal(harness.runs.length, 0);
      yield* hold.release;
      yield* observe.pipe(Effect.provideService(AutomationHold.AutomationHold, hold));
      assert.equal(harness.runs.length, 1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("records a failing check with its exit code and output, once per run", () => {
    const harness = makeLayer({
      worktreePath,
      scripts: [checkScript()],
      outcome: { lines: ["1 failed", "exit"], exitCode: 1 },
    });
    return Effect.gen(function* () {
      const first = yield* observe;
      assert.deepInclude(first, {
        status: "completed",
        command: "vp test run",
        exitCode: 1,
        durationMs: 1_250,
        outputTail: "1 failed\nexit",
      });
      const again = yield* observe;
      assert.deepStrictEqual(again, first);
      assert.strictEqual(harness.runs.length, 1);
      assert.strictEqual(harness.runs[0]?.trigger, "check");
      assert.strictEqual(harness.runs[0]?.worktreePath, worktreePath);
      assert.isUndefined(harness.runs[0]?.cwd);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("skips the shared checkout unless the script opts in", () => {
    const skipped = makeLayer({ worktreePath: null, scripts: [checkScript()] });
    const optedIn = makeLayer({
      worktreePath: null,
      scripts: [checkScript({ checkInSharedCheckout: true })],
      outcome: { lines: [], exitCode: 0 },
    });
    return Effect.gen(function* () {
      const skip = yield* observe.pipe(Effect.provide(skipped.layer));
      assert.deepInclude(skip, {
        status: "skipped",
        skipReason: "shared-checkout",
        exitCode: null,
      });
      assert.strictEqual(skipped.runs.length, 0);

      const ran = yield* observe.pipe(Effect.provide(optedIn.layer));
      assert.deepInclude(ran, { status: "completed", exitCode: 0 });
      assert.strictEqual(optedIn.runs[0]?.cwd, workspaceRoot);
    });
  });

  it.effect("records a missing worktree as skipped and ignores projects without a check", () => {
    const missing = makeLayer({ worktreePath, worktreeExists: false, scripts: [checkScript()] });
    const none = makeLayer({ worktreePath, scripts: [checkScript({ runAsCheck: false })] });
    return Effect.gen(function* () {
      assert.deepInclude(yield* observe.pipe(Effect.provide(missing.layer)), {
        status: "skipped",
        skipReason: "worktree-missing",
      });
      assert.isNull(yield* observe.pipe(Effect.provide(none.layer)));
      assert.strictEqual(none.runs.length, 0);
    });
  });

  it.effect("durably resolves an unconfigured check without exposing a fabricated result", () => {
    const harness = makeLayer({ worktreePath, scripts: [] });
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* ObservedCheckService.readObservedCheckState(threadId, runId), {
        check: null,
        pending: true,
      });
      const service = yield* ObservedCheckService.ObservedCheckService;
      yield* service.observeRun(threadId, runId);
      yield* service.observeRun(threadId, runId);
      assert.deepStrictEqual(yield* ObservedCheckService.readObservedCheckState(threadId, runId), {
        check: null,
        pending: false,
      });
      assert.lengthOf(harness.runs, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("stops a check that outlives the timeout and records it as timed out", () => {
    const harness = makeLayer({ worktreePath, scripts: [checkScript()] });
    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(observe);
      yield* TestClock.adjust(ObservedCheckService.OBSERVED_CHECK_TIMEOUT_MS);
      const result = yield* Fiber.join(fiber);
      assert.deepInclude(result, { status: "timed_out", exitCode: null });
      assert.deepStrictEqual(harness.closed, ["check-test-1"]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("ignores a completed event for a run that is no longer the thread's latest", () => {
    const superseded = makeLayer({
      worktreePath,
      scripts: [checkScript()],
      latestRunId: RunId.make("run-check-2"),
    });
    const busy = makeLayer({
      worktreePath,
      scripts: [checkScript()],
      activeRunId: RunId.make("run-check-2"),
    });
    return Effect.gen(function* () {
      assert.isNull(yield* observe.pipe(Effect.provide(superseded.layer)));
      assert.isNull(yield* observe.pipe(Effect.provide(busy.layer)));
      assert.strictEqual(superseded.runs.length + busy.runs.length, 0);
    });
  });

  it.effect("records a check that failed to start as interrupted", () => {
    const harness = makeLayer({ worktreePath, scripts: [checkScript()], runnerFails: true });
    return Effect.gen(function* () {
      assert.deepInclude(yield* observe, { status: "interrupted", exitCode: null });
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("records a check cut off by shutdown as interrupted and closes its terminal", () => {
    const harness = makeLayer({ worktreePath, scripts: [checkScript()] });
    return Effect.gen(function* () {
      const service = yield* ObservedCheckService.ObservedCheckService;
      const fiber = yield* Effect.forkChild(service.observeRun(threadId, runId));
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(fiber);
      assert.deepInclude(yield* ObservedCheckService.readObservedCheck(threadId, runId), {
        status: "interrupted",
      });
      assert.deepStrictEqual(harness.closed, ["check-test-1"]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "resolves completion committed before a crash without rerunning an unclaimed check",
    () => {
      const harness = makeLayer({ worktreePath, scripts: [checkScript()] });
      return Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, completed_at, payload_json)
        VALUES (${runId}, ${threadId}, 1, 'codex', 'completed', '2026-10-20T00:00:00.000Z', '2026-10-20T00:01:00.000Z', '{}')`;
        assert.deepStrictEqual(
          yield* ObservedCheckService.readObservedCheckState(threadId, runId),
          { check: null, pending: true },
        );
        const service = yield* ObservedCheckService.ObservedCheckService;
        yield* Effect.scoped(service.start());
        yield* Effect.scoped(service.start());
        yield* service.observeRun(threadId, runId);
        assert.deepStrictEqual(
          yield* ObservedCheckService.readObservedCheckState(threadId, runId),
          { check: null, pending: false },
        );
        assert.lengthOf(harness.runs, 0);
        const rows =
          yield* sql`SELECT run_id FROM thread_run_observed_checks WHERE thread_id = ${threadId}`;
        assert.lengthOf(rows, 1);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("marks a check cut off by a restart as interrupted", () => {
    const harness = makeLayer({ worktreePath, scripts: [checkScript()] });
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO thread_run_observed_checks (thread_id, run_id, status, command, started_at)
        VALUES (${threadId}, ${runId}, 'running', 'vp test run', '2026-10-20T00:00:00.000Z')
      `;
      const service = yield* ObservedCheckService.ObservedCheckService;
      yield* Effect.scoped(service.start());
      assert.deepInclude(yield* ObservedCheckService.readObservedCheck(threadId, runId), {
        status: "interrupted",
      });
    }).pipe(Effect.provide(harness.layer));
  });

  it("caps the output tail", () => {
    const tail: Array<string> = [];
    for (let index = 0; index < 100; index += 1) {
      ObservedCheckService.appendOutputTail(tail, `line ${index} ${"x".repeat(200)}`);
    }
    assert.isAtMost(tail.length, ObservedCheckService.OBSERVED_CHECK_OUTPUT_TAIL_LINES);
    assert.isAtMost(tail.join("\n").length, ObservedCheckService.OBSERVED_CHECK_OUTPUT_TAIL_CHARS);
    assert.match(tail.at(-1) ?? "", /^line 99 /);
  });
});
