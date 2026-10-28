import type {
  ActionOutcomeSafety,
  UnappliedInputDiagnostic,
  PreviewAutomationControlReason,
  PreviewAutomationOperation,
} from "@goat/contracts";
import { classifyActionOutcome } from "@goat/shared/actionOutcomeSafety";

export interface BrowserActionOutcomeInput {
  readonly operation: PreviewAutomationOperation;
  readonly status: "completed" | "failed";
  readonly errorTag?: string | undefined;
  readonly controlReason?: PreviewAutomationControlReason | undefined;
  /**
   * Whether the browser action had already passed SessionControl.dispatchGate when the error
   * occurred. When omitted on timeout or execution errors, the classifier fails closed and
   * assumes a write may have reached the page.
   */
  readonly dispatched?: boolean | undefined;
  readonly unappliedInput?: UnappliedInputDiagnostic | undefined;
}

/** Reasons GOAT only raises while admitting a request, before any input can leave. */
export const PREVIEW_ADMISSION_REASONS: ReadonlySet<PreviewAutomationControlReason> = new Set([
  "agentMismatch",
  "dialogPending",
  "tabRequired",
  "tabLimit",
]);

const READ_BROWSER_OPERATIONS: ReadonlySet<PreviewAutomationOperation> = new Set([
  "status",
  "snapshot",
  "read",
  "logs",
  "fetch",
  "waitFor",
]);

export function classifyBrowserControlReason(
  reason: PreviewAutomationControlReason | undefined,
): "transient" | "reobserve" | "fix_input" | "terminal" {
  switch (reason) {
    case "interrupted":
    case "closed":
      return "reobserve";
    case "tabRequired":
    case "dialogPending":
    case "tabLimit":
      return "fix_input";
    case "agentMismatch":
    case "humanControl":
    case "privateMode":
    case "stopped":
    case undefined:
      return "terminal";
  }
}

export function classifyBrowserActionOutcome(
  input: BrowserActionOutcomeInput,
): ActionOutcomeSafety {
  const effect: "read" | "write" = READ_BROWSER_OPERATIONS.has(input.operation) ? "read" : "write";
  if (input.status === "completed") {
    if (input.unappliedInput !== undefined) {
      return classifyActionOutcome({
        effect,
        status: "unapplied",
        unappliedInput: input.unappliedInput,
      });
    }
    return classifyActionOutcome({ effect, status: "completed" });
  }

  if (input.unappliedInput !== undefined && input.dispatched !== true) {
    return classifyActionOutcome({
      effect,
      status: "unapplied",
      unappliedInput: input.unappliedInput,
    });
  }

  switch (input.errorTag) {
    case "PreviewAutomationInvalidSelectorError":
    case "PreviewAutomationTargetNotEditableError":
      return classifyActionOutcome({
        effect,
        status: "refused",
        dispatched: false,
        refusalCategory: "fix_input",
        unappliedInput: input.unappliedInput,
      });
    case "PreviewAutomationTabNotFoundError":
      return classifyActionOutcome({
        effect,
        status: "refused",
        dispatched: false,
        refusalCategory: "reobserve",
      });
    case "PreviewAutomationRequestQueueClosedError":
    case "PreviewAutomationNoAvailableHostError":
      return classifyActionOutcome({
        effect,
        status: "refused",
        dispatched: false,
        refusalCategory: "transient",
      });
    case "PreviewAutomationControlInterruptedError":
      return classifyActionOutcome({
        effect,
        status: "refused",
        dispatched:
          input.dispatched ??
          (input.controlReason === undefined ||
            !PREVIEW_ADMISSION_REASONS.has(input.controlReason)),
        refusalCategory: classifyBrowserControlReason(input.controlReason),
      });
    case "PreviewAutomationTimeoutError":
      return classifyActionOutcome({
        effect,
        status: "timed_out",
        dispatched: input.dispatched ?? true,
      });
    case "PreviewAutomationClientDisconnectedError":
    case "PreviewAutomationExecutionError":
    default:
      // The host's word that it failed before any input left: change something, then retry.
      if (input.dispatched === false)
        return classifyActionOutcome({
          effect,
          status: "refused",
          dispatched: false,
          refusalCategory: "fix_input",
        });
      return classifyActionOutcome({
        effect,
        status: "indeterminate",
        dispatched: input.dispatched ?? true,
        unappliedInput: input.unappliedInput,
      });
  }
}
