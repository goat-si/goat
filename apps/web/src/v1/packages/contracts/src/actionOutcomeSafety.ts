import * as Schema from "effect/Schema";

export const ActionRetryClass = Schema.Literals(["never", "fix_input", "same_key", "new_key"]);
export type ActionRetryClass = typeof ActionRetryClass.Type;
export const ActionWriteStatus = Schema.Literals([
  "not_applicable",
  "not_started",
  "rejected_before_commit",
  "may_have_applied",
  "committed",
]);
export const ActionOutcomeCode = Schema.Literals([
  "read_completed",
  "read_failed_pre_dispatch",
  "read_timed_out",
  "read_indeterminate",
  "write_committed",
  "write_unapplied",
  "write_refused_transient",
  "write_refused_reobserve",
  "write_refused_fix_input",
  "write_refused_terminal",
  "write_timed_out",
  "write_partial",
  "write_indeterminate",
]);
export const UnappliedInputDiagnostic = Schema.Struct({
  field: Schema.String,
  requested: Schema.String,
  applied: Schema.optional(Schema.String),
  step: Schema.optional(Schema.String),
  siteMessage: Schema.optional(Schema.String),
});
export type UnappliedInputDiagnostic = typeof UnappliedInputDiagnostic.Type;
export const ActionOutcomeSafety = Schema.Struct({
  possibleCommit: Schema.Boolean,
  retryClass: ActionRetryClass,
  writeStatus: ActionWriteStatus,
  code: ActionOutcomeCode,
  unappliedInput: Schema.optional(UnappliedInputDiagnostic),
});
export type ActionOutcomeSafety = typeof ActionOutcomeSafety.Type;
