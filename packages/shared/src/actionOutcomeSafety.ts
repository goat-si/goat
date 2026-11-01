import type {
  ActionOutcomeSafety,
  ActionRetryClass,
  UnappliedInputDiagnostic,
  ComputerUseActionResult,
  ComputerUseRefusalReason,
} from "@goat/contracts";

export interface ActionOutcomeInput {
  readonly effect: "read" | "write";
  readonly status:
    | "completed"
    | "refused"
    | "unapplied"
    | "partial"
    | "timed_out"
    | "indeterminate";
  /** Whether input already crossed the dispatch gate before a timeout or interruption occurred. */
  readonly dispatched?: boolean | undefined;
  readonly refusalCategory?: "transient" | "reobserve" | "fix_input" | "terminal" | undefined;
  readonly unappliedInput?: UnappliedInputDiagnostic | undefined;
}

const TRANSIENT_CU_REFUSALS: ReadonlySet<ComputerUseRefusalReason> = new Set([
  "busy",
  "helperUnavailable",
]);

const REOBSERVE_CU_REFUSALS: ReadonlySet<ComputerUseRefusalReason> = new Set([
  "staleElement",
  "epochChanged",
  "windowNotFound",
  "ownerMismatch",
  "targetGone",
]);

const FIX_INPUT_CU_REFUSALS: ReadonlySet<ComputerUseRefusalReason> = new Set([
  "invalidRequest",
  "frameTooLarge",
  "foregroundNotAllowed",
  "backgroundUnavailable",
  "targetRefused",
  "leaseRequired",
]);

function normalizeUnappliedInput(
  diagnostic: UnappliedInputDiagnostic | undefined,
): UnappliedInputDiagnostic | undefined {
  if (diagnostic === undefined) return undefined;
  const field = diagnostic.field.trim();
  if (field.length === 0) return undefined;
  const step = diagnostic.step?.trim();
  const siteMessage = diagnostic.siteMessage?.trim();
  return {
    field,
    requested: diagnostic.requested,
    ...(diagnostic.applied === undefined ? {} : { applied: diagnostic.applied }),
    ...(step && step.length > 0 ? { step } : {}),
    ...(siteMessage && siteMessage.length > 0 ? { siteMessage } : {}),
  };
}

const withOptionalUnapplied = (
  base: Omit<ActionOutcomeSafety, "unappliedInput">,
  diagnostic: UnappliedInputDiagnostic | undefined,
): ActionOutcomeSafety => {
  const normalized = normalizeUnappliedInput(diagnostic);
  return normalized === undefined ? base : { ...base, unappliedInput: normalized };
};

/**
 * Classifies whether an action may have mutated target state and how a caller may safely retry.
 * Uncertain writes fail closed (possibleCommit: true, retryClass: "never") so callers re-read
 * target state instead of replaying a side effect.
 */
export function classifyActionOutcome(input: ActionOutcomeInput): ActionOutcomeSafety {
  if (input.effect === "read") {
    switch (input.status) {
      case "completed":
        return {
          possibleCommit: false,
          retryClass: "never",
          writeStatus: "not_applicable",
          code: "read_completed",
        };
      case "refused":
      case "unapplied": {
        const category = input.refusalCategory ?? "fix_input";
        const retryClass: ActionRetryClass =
          category === "transient"
            ? "same_key"
            : category === "reobserve"
              ? "new_key"
              : category === "terminal"
                ? "never"
                : "fix_input";
        return withOptionalUnapplied(
          {
            possibleCommit: false,
            retryClass,
            writeStatus: "not_applicable",
            code: "read_failed_pre_dispatch",
          },
          input.unappliedInput,
        );
      }
      case "timed_out":
        return {
          possibleCommit: false,
          retryClass: "same_key",
          writeStatus: "not_applicable",
          code: "read_timed_out",
        };
      case "partial":
      case "indeterminate":
        return {
          possibleCommit: false,
          retryClass: "same_key",
          writeStatus: "not_applicable",
          code: "read_indeterminate",
        };
    }
  }

  switch (input.status) {
    case "completed":
      return {
        possibleCommit: true,
        retryClass: "never",
        writeStatus: "committed",
        code: "write_committed",
      };
    case "unapplied":
      // Input that went out is never shown to have left the target untouched.
      if (input.dispatched === true)
        return withOptionalUnapplied(
          {
            possibleCommit: true,
            retryClass: "never",
            writeStatus: "may_have_applied",
            code: "write_indeterminate",
          },
          input.unappliedInput,
        );
      return withOptionalUnapplied(
        {
          possibleCommit: false,
          retryClass: "fix_input",
          writeStatus: "rejected_before_commit",
          code: "write_unapplied",
        },
        input.unappliedInput,
      );
    case "refused": {
      if (input.dispatched === true) {
        return {
          possibleCommit: true,
          retryClass: "never",
          writeStatus: "may_have_applied",
          code: "write_indeterminate",
        };
      }
      switch (input.refusalCategory ?? "terminal") {
        case "transient":
          return {
            possibleCommit: false,
            retryClass: "same_key",
            writeStatus: "not_started",
            code: "write_refused_transient",
          };
        case "reobserve":
          return {
            possibleCommit: false,
            retryClass: "new_key",
            writeStatus: "not_started",
            code: "write_refused_reobserve",
          };
        case "fix_input":
          return withOptionalUnapplied(
            {
              possibleCommit: false,
              retryClass: "fix_input",
              writeStatus: "rejected_before_commit",
              code: "write_refused_fix_input",
            },
            input.unappliedInput,
          );
        case "terminal":
          return {
            possibleCommit: false,
            retryClass: "never",
            writeStatus: "not_started",
            code: "write_refused_terminal",
          };
      }
    }
    case "partial":
      return withOptionalUnapplied(
        {
          possibleCommit: true,
          retryClass: "never",
          writeStatus: "may_have_applied",
          code: "write_partial",
        },
        input.unappliedInput,
      );
    case "timed_out":
      if (input.dispatched === false) {
        return {
          possibleCommit: false,
          retryClass: "same_key",
          writeStatus: "not_started",
          code: "write_refused_transient",
        };
      }
      return {
        possibleCommit: true,
        retryClass: "never",
        writeStatus: "may_have_applied",
        code: "write_timed_out",
      };
    case "indeterminate":
      if (input.dispatched === false) {
        return {
          possibleCommit: false,
          retryClass: "same_key",
          writeStatus: "not_started",
          code: "write_refused_transient",
        };
      }
      return {
        possibleCommit: true,
        retryClass: "never",
        writeStatus: "may_have_applied",
        code: "write_indeterminate",
      };
  }
}

function classifyComputerUseRefusalReason(
  reason: ComputerUseRefusalReason,
): "transient" | "reobserve" | "fix_input" | "terminal" {
  if (TRANSIENT_CU_REFUSALS.has(reason)) return "transient";
  if (REOBSERVE_CU_REFUSALS.has(reason)) return "reobserve";
  if (FIX_INPUT_CU_REFUSALS.has(reason)) return "fix_input";
  return "terminal";
}

export function classifyComputerUseActionOutcome(
  result: ComputerUseActionResult,
  options?: {
    readonly effect?: "read" | "write" | undefined;
    readonly unappliedInput?: UnappliedInputDiagnostic | undefined;
  },
): ActionOutcomeSafety {
  const effect = options?.effect ?? "write";
  switch (result.outcome) {
    case "confirmed":
      return classifyActionOutcome({ effect, status: "completed" });
    case "suspected_noop":
      return withOptionalUnapplied(
        classifyActionOutcome({ effect, status: "indeterminate", dispatched: true }),
        options?.unappliedInput,
      );
    case "partial":
      return classifyActionOutcome({
        effect,
        status: "partial",
        dispatched: true,
        unappliedInput: options?.unappliedInput,
      });
    case "unverifiable": {
      const timedOut =
        typeof result.detail === "string" &&
        (result.detail.toLowerCase().includes("deadline") ||
          result.detail.toLowerCase().includes("timed out"));
      return classifyActionOutcome({
        effect,
        status: timedOut ? "timed_out" : "indeterminate",
        dispatched: true,
        unappliedInput: options?.unappliedInput,
      });
    }
    case "refused":
      return classifyActionOutcome({
        effect,
        status: "refused",
        dispatched: false,
        refusalCategory: classifyComputerUseRefusalReason(result.reason),
        unappliedInput: options?.unappliedInput,
      });
  }
}

/**
 * Returns true only when an action definitely left target state untouched and can be retried
 * with the exact same request parameters.
 */
export function isSafeToAutoRetry(outcome: ActionOutcomeSafety): boolean {
  return (
    !outcome.possibleCommit &&
    outcome.retryClass === "same_key" &&
    (outcome.writeStatus === "not_applicable" || outcome.writeStatus === "not_started")
  );
}
