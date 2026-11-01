import { assert, it } from "@effect/vitest";
import { NodeId, RunId, ThreadId, type OrchestrationV2ServerCommand } from "@goat/contracts";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import {
  recordRemoteTaskResult,
  importRemoteTaskClaim,
  observeRemoteTask,
  replayRemoteTaskCancel,
  requestRemoteTaskCancel,
  recoverUnknownRemoteTaskLaunch,
  waitForRemoteTask,
  RemoteTaskError,
  type TaskDispatch,
} from "./recordRemoteTaskResult.ts";

const remoteResults = (commands: ReadonlyArray<OrchestrationV2ServerCommand>) =>
  commands.filter(
    (
      command,
    ): command is Extract<
      OrchestrationV2ServerCommand,
      { readonly type: "delegated_task.remote.result" }
    > => command.type === "delegated_task.remote.result",
  );

const row: TaskDispatch = {
  correlationId: "rr-test",
  originThreadId: ThreadId.make("origin"),
  host: "build-box",
  remoteThreadId: "remote",
  launchedRunId: "run-A",
  task: { taskId: NodeId.make("task"), parentRunId: RunId.make("parent") },
  cancelRequestedAt: null,
  cancelCeiling: null,
};
const withFixture = <A, E>(
  test: (
    commands: Ref.Ref<Array<OrchestrationV2ServerCommand>>,
  ) => Effect.Effect<
    A,
    E,
    | ThreadManagementService.ThreadManagementService
    | SshRemoteDispatch.SshRemoteDispatch
    | SqlClient.SqlClient
  >,
) =>
  Effect.gen(function* () {
    const commands = yield* Ref.make<Array<OrchestrationV2ServerCommand>>([]);
    const dependencies = Layer.mergeAll(
      NodeSqliteClient.layer({ filename: ":memory:" }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(liveThreadShell(row.originThreadId)),
        dispatch: (command) =>
          Ref.update(commands, (all) => [...all, command]).pipe(Effect.as({} as never)),
      }),
      Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({
        callHostTool: () => Effect.die("unused SSH call"),
      }),
    );
    return yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE remote_dispatches (correlation_id TEXT PRIMARY KEY, kind TEXT,
        state TEXT, cancel_requested_at TEXT, cancel_ceiling TEXT, updated_at TEXT)`;
      yield* sql`INSERT INTO remote_dispatches VALUES ('rr-test','task','running',NULL,NULL,NULL)`;
      return yield* test(commands);
    }).pipe(Effect.provide(dependencies));
  });

it.effect("claims progress and needs_input but never a terminal task result", () =>
  withFixture((commands) =>
    Effect.gen(function* () {
      let sequence = 0;
      for (const kind of ["progress", "completed", "failed", "needs_input"] as const) {
        const needsInput = yield* importRemoteTaskClaim(row, {
          sequence: ++sequence,
          kind,
          runId: RunId.make("run-A"),
          summary: "claim",
          createdAt: "2026-10-12T00:00:00Z",
        });
        assert.equal(needsInput, kind === "needs_input");
      }
      assert.equal((yield* Ref.get(commands)).length, 4);
      assert.isTrue(
        (yield* Ref.get(commands)).every((c) => c.type === "delegated_task.remote.progress"),
      );
      yield* importRemoteTaskClaim(row, {
        sequence: 2,
        kind: "completed",
        runId: RunId.make("run-B"),
        summary: "unrelated",
        createdAt: "2026-10-12T00:00:00Z",
      });
      assert.equal((yield* Ref.get(commands)).length, 4);
    }),
  ),
);
it.effect.each(["preparing", "queued", "starting", "running", "waiting"] as const)(
  "keeps %s nonterminal",
  (status) =>
    withFixture((commands) =>
      Effect.gen(function* () {
        assert.isNull(
          yield* observeRemoteTask(row, { runId: RunId.make("run-A"), status, summary: null }),
        );
        assert.isNull(yield* observeRemoteTask(row, null));
        assert.equal((yield* Ref.get(commands)).length, 0);
      }),
    ),
);
it.effect.each(["completed", "failed", "cancelled", "interrupted", "rolled_back"] as const)(
  "settles observed A as %s after B exists",
  (status) =>
    withFixture((commands) =>
      Effect.gen(function* () {
        assert.isNull(
          yield* observeRemoteTask(row, {
            runId: RunId.make("run-B"),
            status: "completed",
            summary: "B must not win",
          }),
        );
        yield* observeRemoteTask(row, { runId: RunId.make("run-A"), status, summary: "A result" });
        const results = remoteResults(yield* Ref.get(commands));
        assert.equal(results.length, 1);
        assert.equal(results[0]?.status, status === "rolled_back" ? "interrupted" : status);
        assert.equal(results[0]?.summary, "A result");
      }),
    ),
);
it.effect("publishes cancelled only after the flagged A settles", () =>
  withFixture((commands) =>
    Effect.gen(function* () {
      const flagged = {
        ...row,
        cancelRequestedAt: "2026-10-12T00:00:00Z",
        cancelCeiling: "full-access" as const,
      };
      yield* observeRemoteTask(flagged, {
        runId: RunId.make("run-A"),
        status: "running",
        summary: null,
      });
      assert.equal((yield* Ref.get(commands)).length, 0);
      assert.equal(
        yield* observeRemoteTask(flagged, {
          runId: RunId.make("run-A"),
          status: "interrupted",
          summary: "settled",
        }),
        "cancelled",
      );
      assert.equal(remoteResults(yield* Ref.get(commands))[0]?.status, "cancelled");
    }),
  ),
);
it.effect("persists intent before accepted interrupt without publishing cancellation", () =>
  withFixture((commands) =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const sql = yield* SqlClient.SqlClient;
      const layer = Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({
        callHostTool: (call, authorize) =>
          Effect.gen(function* () {
            yield* authorize;
            const intent = yield* sql<{
              cancel_ceiling: string;
            }>`SELECT cancel_ceiling FROM remote_dispatches`.pipe(Effect.orDie);
            assert.equal(intent[0]?.cancel_ceiling, "full-access");
            assert.equal(call.arguments.runId, "run-A");
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
            yield* authorize;
            return {
              host: "build-box",
              threadId: "remote",
              runId: "run-A",
              status: "interrupt_requested",
            };
          }),
      });
      const fiber = yield* requestRemoteTaskCancel(
        row,
        Effect.succeed("full-access" as const),
      ).pipe(Effect.provide(layer), Effect.forkChild);
      yield* Deferred.await(started);
      assert.equal((yield* Ref.get(commands)).length, 0);
      yield* Deferred.succeed(release, undefined);
      assert.equal(yield* Fiber.join(fiber), "cancel_requested");
      assert.equal((yield* Ref.get(commands)).length, 0);
    }),
  ),
);
it.effect("replays persisted cancellation after crash before interrupt with its ceiling", () =>
  withFixture((commands) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE remote_dispatches SET cancel_requested_at = '2026-10-12T00:00:00Z',
      cancel_ceiling = 'auto-accept-edits'`;
      const intent = (yield* sql<{
        cancel_requested_at: string;
        cancel_ceiling: "auto-accept-edits";
      }>`
      SELECT cancel_requested_at, cancel_ceiling FROM remote_dispatches`)[0]!;
      let calls = 0;
      yield* replayRemoteTaskCancel({
        ...row,
        cancelRequestedAt: intent.cancel_requested_at,
        cancelCeiling: intent.cancel_ceiling,
      }).pipe(
        Effect.provide(
          Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({
            callHostTool: (call, authorize) =>
              Effect.gen(function* () {
                assert.equal(yield* authorize, "auto-accept-edits");
                assert.equal(call.arguments.runId, "run-A");
                calls += 1;
                return {
                  host: "build-box",
                  threadId: "remote",
                  runId: "run-A",
                  status: "no_active_run",
                };
              }),
          }),
        ),
      );
      assert.equal(calls, 1);
      assert.equal((yield* Ref.get(commands)).length, 0);
    }),
  ),
);
it.effect("parks launching cancellation and rejects a replay above current authority", () =>
  withFixture((commands) =>
    Effect.gen(function* () {
      assert.equal(
        yield* requestRemoteTaskCancel(
          { ...row, remoteThreadId: null, launchedRunId: null },
          Effect.succeed("full-access" as const),
        ),
        "cancel_requested",
      );
      const flagged = {
        ...row,
        cancelRequestedAt: "2026-10-12T00:00:00Z",
        cancelCeiling: "full-access" as const,
      };
      const failed = yield* replayRemoteTaskCancel(flagged).pipe(
        Effect.provide(
          Layer.merge(
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              getThreadShell: () =>
                Effect.succeed(liveThreadShell(row.originThreadId, { runtimeMode: "auto" })),
            }),
            Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({
              callHostTool: (_call, authorize) =>
                authorize.pipe(Effect.andThen(Effect.die("must refuse before I/O"))),
            }),
          ),
        ),
        Effect.flip,
      );
      assert.instanceOf(failed, RemoteTaskError);
      assert.equal((yield* Ref.get(commands)).length, 0);
    }),
  ),
);
it.effect.each([true, false])("reconnects to A after B starts using %s", (supported) =>
  withFixture((commands) =>
    Effect.gen(function* () {
      const answer = yield* waitForRemoteTask({
        row,
        reportsSupported: supported,
        readKey: "0".repeat(64),
        afterSequence: 0,
        knownRun: null,
      }).pipe(
        Effect.provide(
          Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({
            callHostTool: (call, authorize) =>
              Effect.gen(function* () {
                assert.equal(yield* authorize, "approval-required");
                assert.equal(supported ? call.arguments.watchRunId : call.arguments.runId, "run-A");
                if (supported)
                  return {
                    threadId: "remote",
                    reports: [],
                    hasMore: false,
                    latestRunId: "run-B",
                    observedRun: { runId: "run-A", status: "completed", summary: "A done" },
                    timedOut: false,
                  };
                return {
                  host: "build-box",
                  threadId: "remote",
                  runId: "run-A",
                  status: "completed",
                  timedOut: false,
                };
              }),
          }),
        ),
      );
      yield* observeRemoteTask(row, answer.observedRun);
      const result = remoteResults(yield* Ref.get(commands))[0];
      assert.equal(result?.status, "completed");
      assert.equal(
        result?.summary,
        supported ? "A done" : "The launched remote run ended with status completed.",
      );
    }),
  ),
);
it.effect("classifies restart unknown launch and bounds its summary", () =>
  withFixture((commands) =>
    Effect.gen(function* () {
      yield* recoverUnknownRemoteTaskLaunch({ ...row, remoteThreadId: null, launchedRunId: null });
      const result = remoteResults(yield* Ref.get(commands))[0];
      assert.equal(result?.status, "failed");
      assert.isTrue(result?.summary?.startsWith("launch outcome unknown") ?? false);
    }),
  ),
);

it.effect.each(["missing", "deleted", "archived", "plan", "no-ceiling"] as const)(
  "cancel replay refuses %s before SSH writes",
  (condition) =>
    withFixture((commands) =>
      Effect.gen(function* () {
        const caller = liveThreadShell(row.originThreadId);
        const shell =
          condition === "missing"
            ? null
            : {
                ...caller,
                ...(condition === "deleted"
                  ? { deletedAt: caller.createdAt }
                  : condition === "archived"
                    ? { archivedAt: caller.createdAt }
                    : condition === "plan"
                      ? { interactionMode: "plan" as const }
                      : {}),
              };
        const result = yield* replayRemoteTaskCancel({
          ...row,
          cancelRequestedAt: "2026-10-12T00:00:00Z",
          cancelCeiling: condition === "no-ceiling" ? null : "full-access",
        }).pipe(
          Effect.provide(
            Layer.merge(
              Layer.mock(ThreadManagementService.ThreadManagementService)({
                getThreadShell: () => Effect.succeed(shell),
              }),
              Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({
                callHostTool: (_call, authorize) =>
                  authorize.pipe(Effect.andThen(Effect.die("No write is authorized"))),
              }),
            ),
          ),
          Effect.result,
        );
        assert.equal(result._tag, "Failure");
        assert.equal((yield* Ref.get(commands)).length, 0);
      }),
    ),
);

it.effect("result summaries are bounded and use the deterministic receipt", () =>
  withFixture((commands) =>
    Effect.gen(function* () {
      yield* recordRemoteTaskResult({ ...row, status: "completed", summary: "x".repeat(8_000) });
      const result = remoteResults(yield* Ref.get(commands))[0]!;
      assert.equal(result.summary.length, 4_000);
      assert.equal(result.commandId, "remote-task-result:rr-test");
    }),
  ),
);

it.effect.each(["completed", "failed", "rolled_back"] as const)(
  "a pending cancel preserves observed %s rather than relabelling it",
  (status) =>
    withFixture((commands) =>
      Effect.gen(function* () {
        yield* observeRemoteTask(
          { ...row, cancelRequestedAt: "2026-10-12T00:00:00Z", cancelCeiling: "full-access" },
          { runId: RunId.make("run-A"), status, summary: "observed result" },
        );
        assert.equal(
          remoteResults(yield* Ref.get(commands))[0]?.status,
          status === "rolled_back" ? "interrupted" : status,
        );
      }),
    ),
);
