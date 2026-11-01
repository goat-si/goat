import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

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
