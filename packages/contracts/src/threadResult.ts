import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  RunId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { OrchestrationV2RunStatus } from "./orchestrationV2.ts";

/**
 * How a dispatched thread's run ended, as its agent reported it. The run's own
 * status settles failed and cancelled runs that never reported.
 */
export const ThreadResultOutcome = Schema.Literals(["succeeded", "failed", "blocked", "cancelled"]);
export type ThreadResultOutcome = typeof ThreadResultOutcome.Type;

export const THREAD_RESULT_SUMMARY_MAX_CHARS = 4000;

export const ThreadResultPullRequest = Schema.Struct({
  url: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)),
  number: Schema.optional(PositiveInt),
  /** Host state such as open, merged, or closed, when known. */
  state: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(32))),
});
export type ThreadResultPullRequest = typeof ThreadResultPullRequest.Type;

export const ThreadResultTests = Schema.Struct({
  command: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(2000))),
  passed: Schema.optional(NonNegativeInt),
  failed: Schema.optional(NonNegativeInt),
  skipped: Schema.optional(NonNegativeInt),
  ok: Schema.Boolean,
});
export type ThreadResultTests = typeof ThreadResultTests.Type;

/**
 * The project's check script as GOAT ran it after the run completed, independent
 * of what the agent reported. `running` until the script exits; `timed_out` and
 * `interrupted` (server stopped) carry a null exit code, as does a terminal that
 * closed before the script reported one.
 */
export const ThreadResultObservedCheck = Schema.Struct({
  status: Schema.Literals(["running", "completed", "timed_out", "interrupted", "skipped"]),
  /** Why the check did not run: the thread works in the shared checkout, or its worktree is gone. */
  skipReason: Schema.optional(Schema.Literals(["shared-checkout", "worktree-missing"])),
  command: Schema.String,
  exitCode: Schema.NullOr(Schema.Int),
  durationMs: Schema.NullOr(NonNegativeInt),
  /** When the check started, or was skipped. */
  at: IsoDateTime,
  /** The last lines the script printed, capped. */
  outputTail: Schema.optional(Schema.String),
});
export type ThreadResultObservedCheck = typeof ThreadResultObservedCheck.Type;

const CommitSha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{7,64}$/i));

/** What an agent reports about its own run with goat_thread_report_result. */
export const ThreadResultReport = Schema.Struct({
  outcome: ThreadResultOutcome,
  summary: Schema.optional(
    Schema.String.check(Schema.isMaxLength(THREAD_RESULT_SUMMARY_MAX_CHARS)),
  ),
  pullRequests: Schema.optional(
    Schema.Array(ThreadResultPullRequest).check(Schema.isMaxLength(20)),
  ),
  tests: Schema.optional(ThreadResultTests),
  commits: Schema.optional(Schema.Array(CommitSha).check(Schema.isMaxLength(100))),
  branch: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
});
export type ThreadResultReport = typeof ThreadResultReport.Type;

/**
 * The structured result of one run of a thread: the agent's own report merged
 * with what GOAT already knows (the run's status, pull requests linked to the
 * thread, its branch). Nothing here is read from chat text. Thread reads and
 * waits return it, and completion notifications should reuse the same shape.
 */
export const ThreadResult = Schema.Struct({
  runId: RunId,
  runStatus: OrchestrationV2RunStatus,
  /**
   * The reported outcome; without a report, failed or cancelled when the run's
   * status says so, otherwise null.
   */
  outcome: Schema.NullOr(ThreadResultOutcome),
  /** When the agent reported; null when it did not. */
  reportedAt: Schema.NullOr(IsoDateTime),
  summary: Schema.optional(Schema.String),
  /** Reported pull requests first, then those linked to the thread. */
  pullRequests: Schema.Array(ThreadResultPullRequest),
  tests: Schema.optional(ThreadResultTests),
  /** What GOAT observed running the project's check script, beside the agent's own `tests`. */
  observedCheck: Schema.optional(ThreadResultObservedCheck),
  commits: Schema.Array(Schema.String),
  branch: Schema.NullOr(Schema.String),
});
export type ThreadResult = typeof ThreadResult.Type;
