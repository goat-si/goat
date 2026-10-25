import {
  ProjectId,
  type RunId,
  type ThreadId,
  type ThreadResultObservedCheck,
} from "@goat/contracts";
import { checkProjectScript, resolveProjectScripts } from "@goat/shared/projectScripts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as AutomationHold from "../automationHold.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import * as TerminalManager from "../terminal/Manager.ts";

/** A check that outlives this is stopped and recorded as timed out. */
export const OBSERVED_CHECK_TIMEOUT_MS = 10 * 60 * 1_000;
export const OBSERVED_CHECK_OUTPUT_TAIL_LINES = 40;
export const OBSERVED_CHECK_OUTPUT_TAIL_CHARS = 4_000;

const ObservedCheckRow = Schema.Struct({
  // Internal disposition, not a check result: no script ran and no pass is implied.
  status: Schema.Literals([
    "running",
    "completed",
    "timed_out",
    "interrupted",
    "skipped",
    "not_run",
  ]),
  skipReason: Schema.NullOr(Schema.Literals(["shared-checkout", "worktree-missing"])),
  command: Schema.String,
  exitCode: Schema.NullOr(Schema.Number),
  durationMs: Schema.NullOr(Schema.Number),
  startedAt: Schema.String,
  outputTail: Schema.NullOr(Schema.String),
});
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(ObservedCheckRow));

/** Absence is pending until the producer durably decides whether a check runs. */
export const readObservedCheckState = Effect.fn("ObservedCheckService.readState")(function* (
  threadId: ThreadId,
  runId: RunId,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`
      SELECT status, skip_reason AS "skipReason", command, exit_code AS "exitCode",
        duration_ms AS "durationMs", started_at AS "startedAt", output_tail AS "outputTail"
      FROM thread_run_observed_checks WHERE thread_id = ${threadId} AND run_id = ${runId}
    `.pipe(Effect.flatMap(decodeRows));
  const row = rows[0];
  if (row === undefined) return { check: null, pending: true };
  if (row.status === "not_run") return { check: null, pending: false };
  const check = {
    status: row.status,
    ...(row.skipReason === null ? {} : { skipReason: row.skipReason }),
    command: row.command,
    exitCode: row.exitCode,
    durationMs: row.durationMs,
    at: row.startedAt,
    ...(row.outputTail === null ? {} : { outputTail: row.outputTail }),
  } satisfies ThreadResultObservedCheck;
  return { check, pending: row.status === "running" };
});

export const readObservedCheck = (threadId: ThreadId, runId: RunId) =>
  readObservedCheckState(threadId, runId).pipe(Effect.map((state) => state.check));

/** Keeps the last lines a check printed, bounded in both lines and characters. */
export function appendOutputTail(lines: Array<string>, line: string): void {
  lines.push(line);
  if (lines.length > OBSERVED_CHECK_OUTPUT_TAIL_LINES) lines.shift();
  let total = lines.reduce((sum, entry) => sum + entry.length + 1, 0);
  while (lines.length > 1 && total > OBSERVED_CHECK_OUTPUT_TAIL_CHARS) {
    total -= lines.shift()!.length + 1;
  }
}

/**
 * Runs the project's check script when a thread's run completes and records its
 * exit code beside the agent's reported tests. It never holds the run open: the
 * run has already completed when the event arrives, and a failing check is only
 * evidence. One row per run makes a repeated completion event a no-op.
 */
export class ObservedCheckService extends Context.Service<
  ObservedCheckService,
  {
    /** Runs (or skips) the check for one completed run and waits for its result. */
    readonly observeRun: (threadId: ThreadId, runId: RunId) => Effect.Effect<void>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("goat/threadResults/ObservedCheckService") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectService.ProjectService;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const fileSystem = yield* FileSystem.FileSystem;
  const terminals = yield* TerminalManager.TerminalManager;
  const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;

  const claim = (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly status: "running" | "skipped" | "not_run";
    readonly skipReason: "shared-checkout" | "worktree-missing" | null;
    readonly command: string;
  }) =>
    Effect.gen(function* () {
      const startedAt = DateTime.formatIso(yield* DateTime.now);
      const inserted = yield* sql<{ readonly runId: string }>`
        INSERT INTO thread_run_observed_checks
          (thread_id, run_id, status, skip_reason, command, started_at)
        VALUES (${input.threadId}, ${input.runId}, ${input.status}, ${input.skipReason},
          ${input.command}, ${startedAt})
        ON CONFLICT (thread_id, run_id) DO NOTHING
        RETURNING run_id AS "runId"
      `;
      return inserted.length > 0;
    });

  const finish = (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly status: "completed" | "timed_out";
    readonly exitCode: number | null;
    readonly durationMs: number;
    readonly outputTail: string;
  }) => sql`
    UPDATE thread_run_observed_checks SET status = ${input.status},
      exit_code = ${input.exitCode}, duration_ms = ${input.durationMs},
      output_tail = ${input.outputTail.length > 0 ? input.outputTail : null}
    WHERE thread_id = ${input.threadId} AND run_id = ${input.runId} AND status = 'running'
  `;

  const observeRun = Effect.fn("ObservedCheckService.observeRun")(
    function* (threadId: ThreadId, runId: RunId) {
      // A held copy's reattached runs finish here too; their checks would run scripts on its own.
      if (yield* AutomationHold.isHeld) return;
      const noCheck = claim({ threadId, runId, status: "not_run", skipReason: null, command: "" });
      const thread = yield* projections.getThreadShell(threadId);
      // A completed run's event repeats when its delegated work changes or the
      // thread is deleted; only the latest run, with nothing running after it,
      // owns the worktree as it was left.
      if (thread === null || thread.latestRunId !== runId || thread.activeRunId !== null) {
        yield* noCheck;
        return;
      }
      const project = Option.getOrUndefined(
        yield* projects.getById(ProjectId.make(thread.projectId)),
      );
      if (project === undefined) {
        yield* noCheck;
        return;
      }
      const settings = yield* settingsService.getSettings;
      const script = checkProjectScript(resolveProjectScripts(settings, project));
      if (script === null) {
        yield* noCheck;
        return;
      }

      const worktreePath = thread.worktreePath;
      const skipReason =
        worktreePath === null
          ? script.checkInSharedCheckout === true
            ? null
            : ("shared-checkout" as const)
          : (yield* fileSystem.exists(worktreePath))
            ? null
            : ("worktree-missing" as const);
      if (skipReason !== null) {
        yield* claim({ threadId, runId, status: "skipped", skipReason, command: script.command });
        return;
      }
      if (
        !(yield* claim({
          threadId,
          runId,
          status: "running",
          skipReason: null,
          command: script.command,
        }))
      ) {
        return;
      }

      const tail: Array<string> = [];
      let terminalId: string | null = null;
      // Once claimed, the row must leave `running`: a failure to start or an
      // interrupt (such as shutdown) records the check as interrupted.
      const interrupted = Effect.gen(function* () {
        if (terminalId !== null) {
          yield* terminals.close({ threadId, terminalId }).pipe(Effect.ignore);
        }
        yield* sql`
          UPDATE thread_run_observed_checks SET status = 'interrupted'
          WHERE thread_id = ${threadId} AND run_id = ${runId} AND status = 'running'
        `.pipe(Effect.ignore);
      });
      yield* Effect.gen(function* () {
        const started = yield* runner.runForThread({
          threadId,
          projectId: project.id,
          worktreePath: worktreePath ?? project.workspaceRoot,
          ...(worktreePath === null ? { cwd: project.workspaceRoot } : {}),
          trigger: "check",
          observeCompletion: {
            onOutputLine: (line) => Effect.sync(() => appendOutputTail(tail, line)),
          },
        });
        if (started.status !== "started" || started.completion === undefined) {
          // The script went away between reading settings and starting it.
          yield* sql`
            UPDATE thread_run_observed_checks SET status = 'not_run'
            WHERE thread_id = ${threadId} AND run_id = ${runId} AND status = 'running'
          `;
          return;
        }
        terminalId = started.terminalId;
        const result = yield* started.completion.pipe(
          Effect.timeoutOption(OBSERVED_CHECK_TIMEOUT_MS),
        );
        if (Option.isNone(result)) {
          yield* terminals.close({ threadId, terminalId: started.terminalId }).pipe(Effect.ignore);
        }
        yield* finish({
          threadId,
          runId,
          ...(Option.isSome(result)
            ? {
                status: "completed" as const,
                exitCode: result.value.exitCode,
                durationMs: result.value.durationMs,
              }
            : {
                status: "timed_out" as const,
                exitCode: null,
                durationMs: OBSERVED_CHECK_TIMEOUT_MS,
              }),
          outputTail: tail.join("\n"),
        });
      }).pipe(Effect.onError(() => interrupted));
    },
    (effect, threadId, runId) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("observed check failed to run", {
                threadId,
                runId,
                cause: Cause.pretty(cause),
              }),
        ),
      ),
  );

  const start = Effect.fn("ObservedCheckService.start")(function* () {
    // Completion can commit just before a crash, before this worker claims its row. Do not
    // execute scripts against old worktrees on restart: durably record that no check ran.
    yield* sql`
      INSERT INTO thread_run_observed_checks (thread_id, run_id, status, command, started_at)
      SELECT thread_id, run_id, 'not_run', '', ${DateTime.formatIso(yield* DateTime.now)}
      FROM orchestration_v2_projection_runs
      WHERE status = 'completed'
      ON CONFLICT (thread_id, run_id) DO NOTHING
    `.pipe(
      Effect.catchCause((cause) => Effect.logWarning("unclaimed check recovery failed", { cause })),
    );
    // A check still marked running was cut off when the server last stopped.
    yield* sql`
      UPDATE thread_run_observed_checks SET status = 'interrupted' WHERE status = 'running'
    `.pipe(
      Effect.catchCause((cause) => Effect.logWarning("observed check recovery failed", { cause })),
    );
    // Checks belong to this worker's scope, so shutdown interrupts them and
    // their rows are recorded as interrupted.
    const scope = yield* Effect.scope;
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
        event.type === "run.updated" && event.payload.status === "completed"
          ? observeRun(event.payload.threadId, event.payload.id).pipe(
              Effect.forkIn(scope),
              Effect.asVoid,
            )
          : Effect.void,
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("observed check event stream failed", { cause }),
        ),
      ),
    );
  });

  return ObservedCheckService.of({ observeRun, start });
});

export const layer = Layer.effect(ObservedCheckService, make);
