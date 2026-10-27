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
  const effectStarted =
    operation !== "snapshot" && operation !== "status" && !beforeInput.has(error._tag);
  const message = NodeUtil.stripVTControlCharacters(error.message)
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/\b(?:password|token|secret|authorization|cookie)\s*[:=]\s*\S+/gi, "[redacted]")
    .replace(/\bBearer\s+\S+/gi, "[redacted]")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  return {
    code: effectStarted ? "unknown_outcome" : "downstream_failure",
    effectStarted,
    message,
    nextStep: "Observe the tab before deciding whether to retry.",
  };
};
