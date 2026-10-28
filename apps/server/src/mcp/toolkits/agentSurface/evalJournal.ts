import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

/** Completed runs; halted ones keep longer for a person to act, unless a step is unknown. */
const COMPLETED_RUN_HOURS = 24;
const HALTED_RUN_DAYS = 7;
/**
 * Claims whose run ended but could not be recorded. Their rows still say running under this
 * boot, which would otherwise read as in progress until the next restart.
 */
const ABANDONED_CLAIMS = new Set<string>();

export interface RunRow {
  readonly eval_run_id: string;
  readonly program_digest: string;
  readonly program_json: string;
  readonly bindings_json: string;
  readonly state: "running" | "completed" | "halted";
  readonly boot_id: string;
  readonly claim_id: string;
}

export interface StepRow {
  readonly path: string;
  readonly args_digest: string;
  readonly grant_json: string;
  readonly state: "running" | "completed" | "unknown";
  readonly result_json: string | null;
  readonly created_at: string;
}

export interface NewRun {
  readonly evalRunId: string;
  readonly environmentId: string;
  readonly principal: string;
  readonly clientRequestId: string | null;
  readonly programDigest: string;
  readonly programJson: string;
  readonly bindingsJson: string;
  readonly claimId: string;
}

export interface NewStep {
  readonly evalRunId: string;
  readonly coord: string;
  readonly path: string;
  readonly effect: string;
  readonly argsDigest: string;
  readonly requestId: string | null;
  readonly grantJson: string;
  readonly claimId: string;
}

const now = Effect.map(DateTime.now, DateTime.formatIso);

/** goat_eval's runs and steps (Migrations/113_McpEvalJournal.ts). */
export const makeEvalJournal = (sql: SqlClient.SqlClient, bootId: string) => {
  /** Only a run nobody can still be running is claimed again; another claim reads in progress. */
  const claimable = (run: RunRow) =>
    run.state !== "running" || run.boot_id !== bootId || ABANDONED_CLAIMS.has(run.claim_id);

  const findRun = Effect.fn("EvalJournal.findRun")(function* (
    evalRunId: string,
    environmentId: string,
    principal: string,
  ) {
    const at = yield* now;
    yield* sql`DELETE FROM mcp_eval_steps WHERE eval_run_id IN (SELECT eval_run_id
      FROM mcp_eval_runs WHERE expires_at IS NOT NULL AND expires_at <= ${at})`;
    yield* sql`DELETE FROM mcp_eval_runs WHERE expires_at IS NOT NULL AND expires_at <= ${at}`;
    const [row] = yield* sql<RunRow>`SELECT eval_run_id, program_digest, program_json,
      bindings_json, state, boot_id, claim_id FROM mcp_eval_runs
      WHERE eval_run_id = ${evalRunId} AND environment_id = ${environmentId}
        AND principal = ${principal}`;
    return row;
  });

  /** False when another call created the same run first. */
  const createRun = Effect.fn("EvalJournal.createRun")(function* (run: NewRun) {
    const at = yield* now;
    const inserted = yield* sql<{ readonly eval_run_id: string }>`INSERT INTO mcp_eval_runs
      (eval_run_id, environment_id, principal, client_request_id, program_digest, program_json,
        bindings_json, state, boot_id, claim_id, created_at, updated_at, expires_at)
      VALUES (${run.evalRunId}, ${run.environmentId}, ${run.principal}, ${run.clientRequestId},
        ${run.programDigest}, ${run.programJson}, ${run.bindingsJson}, 'running', ${bootId},
        ${run.claimId}, ${at}, ${at}, NULL)
      ON CONFLICT DO NOTHING RETURNING eval_run_id`;
    return inserted.length === 1;
  });

  /** Fenced by the claim the caller read, so two resumes cannot both run. */
  const claimRun = Effect.fn("EvalJournal.claimRun")(function* (run: RunRow, claimId: string) {
    if (!claimable(run)) return false;
    const claimed = yield* sql<{ readonly eval_run_id: string }>`UPDATE mcp_eval_runs
      SET state = 'running', boot_id = ${bootId}, claim_id = ${claimId},
        updated_at = ${yield* now}, expires_at = NULL
      WHERE eval_run_id = ${run.eval_run_id} AND claim_id = ${run.claim_id}
        AND state = ${run.state}
      RETURNING eval_run_id`;
    return claimed.length === 1;
  });

  const settleRun = Effect.fn("EvalJournal.settleRun")(function* (
    evalRunId: string,
    claimId: string,
    state: "completed" | "halted",
  ) {
    const at = yield* DateTime.now;
    const [unknown] = yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count
      FROM mcp_eval_steps WHERE eval_run_id = ${evalRunId} AND state = 'unknown'`;
    // A run that holds an unknown step stays, as an unknown reservation does.
    const expiresAt =
      state === "completed"
        ? DateTime.formatIso(DateTime.add(at, { hours: COMPLETED_RUN_HOURS }))
        : (unknown?.count ?? 0) > 0
          ? null
          : DateTime.formatIso(DateTime.add(at, { days: HALTED_RUN_DAYS }));
    yield* sql`UPDATE mcp_eval_runs SET state = ${state}, updated_at = ${DateTime.formatIso(at)},
      expires_at = ${expiresAt}
      WHERE eval_run_id = ${evalRunId} AND claim_id = ${claimId}`;
  });

  const abandonRun = (claimId: string) => Effect.sync(() => ABANDONED_CLAIMS.add(claimId));

  const readStep = Effect.fn("EvalJournal.readStep")(function* (evalRunId: string, coord: string) {
    const [row] = yield* sql<StepRow>`SELECT path, args_digest, grant_json, state, result_json,
      created_at FROM mcp_eval_steps
      WHERE eval_run_id = ${evalRunId} AND step_coord = ${coord}`;
    return row;
  });

  /**
   * Records the step and its grant before it runs. A step that ran before keeps its creation
   * time, which bounds how long its derived key's reservation is known to exist.
   */
  const reserveStep = Effect.fn("EvalJournal.reserveStep")(function* (step: NewStep) {
    yield* sql`INSERT INTO mcp_eval_steps (eval_run_id, step_coord, path, effect, args_digest,
        request_id, grant_json, state, boot_id, claim_id, created_at)
      VALUES (${step.evalRunId}, ${step.coord}, ${step.path}, ${step.effect}, ${step.argsDigest},
        ${step.requestId}, ${step.grantJson}, 'running', ${bootId}, ${step.claimId}, ${yield* now})
      ON CONFLICT (eval_run_id, step_coord) DO UPDATE SET state = 'running',
        boot_id = excluded.boot_id, claim_id = excluded.claim_id,
        grant_json = excluded.grant_json, result_json = NULL, completed_at = NULL`;
  });

  /** completed keeps the outcome; released forgets a step that proved nothing ran. */
  const settleStep = Effect.fn("EvalJournal.settleStep")(function* (
    evalRunId: string,
    coord: string,
    settlement: "completed" | "released" | "unknown",
    resultJson: string | null,
  ) {
    if (settlement === "released") {
      yield* sql`DELETE FROM mcp_eval_steps
        WHERE eval_run_id = ${evalRunId} AND step_coord = ${coord} AND state = 'running'`;
      return;
    }
    yield* sql`UPDATE mcp_eval_steps SET state = ${settlement}, result_json = ${resultJson},
      completed_at = ${yield* now}
      WHERE eval_run_id = ${evalRunId} AND step_coord = ${coord}`;
  });

  return {
    claimable,
    findRun,
    createRun,
    claimRun,
    settleRun,
    abandonRun,
    readStep,
    reserveStep,
    settleStep,
  };
};
export type EvalJournal = ReturnType<typeof makeEvalJournal>;
