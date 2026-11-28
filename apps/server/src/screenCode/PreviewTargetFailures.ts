// @effect-diagnostics nodeBuiltinImport:off - Browser diagnostics cross the guest boundary as plain text.
import * as NodeUtil from "node:util";
import type {
  PreviewAutomationClickRefusal,
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
const readOnly = new Set<PreviewAutomationOperation>(["snapshot", "status", "read", "waitFor"]);

const FETCH_NEXT_STEP = {
  cors: "The site does not let this page read it (CORS). Open it with tab.goto(url) and tab.read(), or fetch from a tab on that site.",
  csp: "This page's Content-Security-Policy blocks requests there. Open it with tab.goto(url) and tab.read(), or fetch from a tab on that site.",
  dns: "The host name did not resolve. Check the URL.",
  network: "The request did not reach the site. Check the URL or the connection, then retry.",
} as const;

const CLICK_REFUSAL_NEXT_STEP: Readonly<Record<PreviewAutomationClickRefusal, string>> = {
  occluded_refused:
    "Nothing was sent because another element covers the target; dismiss or scroll past the cover, observe again, then retry.",
  no_visible_area:
    "Nothing was sent because the target has no visible area; scroll it into view or observe again.",
  invalid_geometry:
    "Nothing was sent because the target geometry is invalid; observe again before retrying.",
  oopif_transform_unproven:
    "Nothing was sent because the cross-origin frame transform could not be proven; observe again before retrying.",
  special_element_refused:
    "Nothing was sent; use upload() for file inputs or select() for native select elements.",
};

const sanitizePreviewMessage = (raw: string): string =>
  NodeUtil.stripVTControlCharacters(raw)
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/\b(?:password|token|secret|authorization|cookie)\s*[:=]\s*\S+/gi, "[redacted]")
    .replace(/\bBearer\s+\S+/gi, "[redacted]")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);

const clickRefusalMessage = (raw: string, interceptedBy: string | undefined): string => {
  if (!interceptedBy) return sanitizePreviewMessage(raw);
  const cover = sanitizePreviewMessage(interceptedBy);
  if (!cover) return sanitizePreviewMessage(raw);
  const suffix = ` (covered by ${cover})`;
  const maxBase = Math.max(0, 200 - suffix.length);
  const base = sanitizePreviewMessage(raw).slice(0, maxBase).trimEnd();
  return base.length > 0 ? `${base}${suffix}`.slice(0, 200) : suffix.trimStart().slice(0, 200);
};

export const previewTargetFailure = (
  error: PreviewAutomationError,
  operation: PreviewAutomationOperation,
): ScreenRunError => {
  if (error._tag === "PreviewAutomationControlInterruptedError" && error.reason === "blocked_url") {
    return {
      code: "blocked_url",
      effectStarted: error.dispatched === true,
      nextStep: "A person can change the blocked host setting.",
    };
  }
  const effectStarted = !readOnly.has(operation) && !beforeInput.has(error._tag);
  const message = sanitizePreviewMessage(error.message);
  if (error._tag === "PreviewAutomationExecutionError" && error.clickRefusal !== undefined)
    return {
      code: "unsupported",
      detail: error.clickRefusal,
      effectStarted: false,
      message: clickRefusalMessage(error.reason ?? error.message, error.interceptedBy),
      nextStep: CLICK_REFUSAL_NEXT_STEP[error.clickRefusal],
    };
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
  if (operation === "fetch")
    return {
      code: "downstream_failure",
      effectStarted: false,
      message,
      nextStep:
        "The fetch changed nothing in the tab. Check the URL, or open it with tab.goto(url) and tab.read().",
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
  const dispatched =
    error._tag === "PreviewAutomationExecutionError" && error.clickRefusal !== undefined
      ? (error.dispatched ?? false)
      : "dispatched" in error
        ? error.dispatched
        : undefined;
  const safety = classifyBrowserActionOutcome({
    operation,
    status: "failed",
    errorTag: error._tag,
    ...(error._tag === "PreviewAutomationControlInterruptedError"
      ? { controlReason: error.reason }
      : {}),
    ...(dispatched !== undefined ? { dispatched } : {}),
  });
  const failure = previewTargetFailure(error, operation);
  const kept = ["target_ambiguous", "invalid_argument", "target_missing", "unsupported"].includes(
    failure.code,
  );
  if (failure.code === "blocked_url") return { ...failure, safety };
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
