// @effect-diagnostics nodeBuiltinImport:off - Browser diagnostics cross the guest boundary as plain text.
import * as NodeUtil from "node:util";
import type {
  PreviewAutomationError,
  PreviewAutomationOperation,
  ScreenRunError,
} from "@goat/contracts";

const beforeInput = new Set<PreviewAutomationError["_tag"]>([
  "PreviewAutomationUnavailableError",
  "PreviewAutomationNoAvailableHostError",
  "PreviewAutomationUnsupportedClientError",
  "PreviewAutomationTabNotFoundError",
  "PreviewAutomationInvalidSelectorError",
  "PreviewAutomationTargetNotEditableError",
]);

export const previewTargetFailure = (
  error: PreviewAutomationError,
  operation: PreviewAutomationOperation,
): ScreenRunError => {
  if (
    error._tag === "PreviewAutomationControlInterruptedError" &&
    error.reason === "blocked_url" &&
    error.dispatched !== true
  ) {
    return {
      code: "blocked_url",
      effectStarted: false,
      nextStep: "This tab is blocked for the rest of this turn.",
    };
  }
  const effectStarted =
    operation !== "snapshot" &&
    operation !== "status" &&
    operation !== "read" &&
    operation !== "waitFor" &&
    !beforeInput.has(error._tag);
  const message = NodeUtil.stripVTControlCharacters(error.message)
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/\b(?:password|token|secret|authorization|cookie)\s*[:=]\s*\S+/gi, "[redacted]")
    .replace(/\bBearer\s+\S+/gi, "[redacted]")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  if (error._tag === "PreviewAutomationInvalidSelectorError" && !error.staleRef)
    return {
      code: error.matchCount === undefined ? "invalid_argument" : "target_ambiguous",
      effectStarted: false,
      message,
      nextStep:
        error.matchCount === undefined
          ? "Name the element by a number from observe(), { role, name }, text=..., or a CSS selector."
          : "Narrow the selector to one element, or use a number from observe().",
    };
  return {
    code: effectStarted ? "unknown_outcome" : "downstream_failure",
    effectStarted,
    message,
    nextStep: "Observe the tab before deciding whether to retry.",
  };
};
