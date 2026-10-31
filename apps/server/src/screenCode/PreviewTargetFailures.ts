// @effect-diagnostics nodeBuiltinImport:off - Browser diagnostics cross the guest boundary as plain text.
import * as NodeUtil from "node:util";
import type {
  PreviewAutomationError,
  PreviewAutomationOperation,
  ScreenRunError,
} from "@goat/contracts";
import { classifyBrowserActionOutcome } from "../preview/actionOutcomeSafety.ts";

const beforeInput = new Set<PreviewAutomationError["_tag"]>([
  "PreviewAutomationUnavailableError",
  "PreviewAutomationNoAvailableHostError",
  "PreviewAutomationUnsupportedClientError",
  "PreviewAutomationTabNotFoundError",
  "PreviewAutomationInvalidSelectorError",
  "PreviewAutomationTargetNotEditableError",
]);

/** Operations that only read the tab: a failure leaves nothing that may have landed. */
const readOnly = new Set<PreviewAutomationOperation>([
  "snapshot",
  "status",
  "read",
  "waitFor",
  "fetch",
]);

const FETCH_NEXT_STEP = {
  cors: "The site does not let this page read it (CORS). Open it with tab.goto(url) and tab.read(), or fetch from a tab on that site.",
  csp: "This page's Content-Security-Policy blocks requests there. Open it with tab.goto(url) and tab.read(), or fetch from a tab on that site.",
  dns: "The host name did not resolve. Check the URL.",
  network: "The request did not reach the site. Check the URL or the connection, then retry.",
} as const;

export const previewTargetFailure = (
  error: PreviewAutomationError,
  operation: PreviewAutomationOperation,
): ScreenRunError => {
  const effectStarted = !readOnly.has(operation) && !beforeInput.has(error._tag);
  const message = NodeUtil.stripVTControlCharacters(error.message)
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/\b(?:password|token|secret|authorization|cookie)\s*[:=]\s*\S+/gi, "[redacted]")
    .replace(/\bBearer\s+\S+/gi, "[redacted]")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  if (error._tag === "PreviewAutomationInvalidSelectorError" && error.noMatch)
    return {
      code: "target_missing",
      effectStarted: false,
      message,
      nextStep:
        "Nothing on the page matches that selector; observe() and use a number from it, or waitFor({ target }) for an element that appears later.",
    };
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
  if (error._tag === "PreviewAutomationExecutionError" && error.fetchFailure)
    return {
      code: "downstream_failure",
      effectStarted: false,
      message,
      detail: error.fetchFailure,
      nextStep: FETCH_NEXT_STEP[error.fetchFailure],
    };
  return {
    code: effectStarted ? "unknown_outcome" : "downstream_failure",
    effectStarted,
    message,
    nextStep: "Observe the tab before deciding whether to retry.",
  };
};

/** An input's failure: unknown_outcome whenever it may have landed, with the refusals that say why. */
export const previewActionFailure = (
  error: PreviewAutomationError,
  operation: PreviewAutomationOperation,
) => {
  const safety = classifyBrowserActionOutcome({
    operation,
    status: "failed",
    errorTag: error._tag,
    ...(error._tag === "PreviewAutomationControlInterruptedError"
      ? { controlReason: error.reason }
      : {}),
    ...("dispatched" in error && error.dispatched !== undefined
      ? { dispatched: error.dispatched }
      : {}),
  });
  const failure = previewTargetFailure(error, operation);
  const kept = ["target_ambiguous", "invalid_argument", "target_missing"].includes(failure.code);
  return {
    ...failure,
    code: safety.possibleCommit
      ? ("unknown_outcome" as const)
      : kept
        ? failure.code
        : ("downstream_failure" as const),
    effectStarted: safety.possibleCommit,
    safety,
  };
};
