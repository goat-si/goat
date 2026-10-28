import type { ActionOutcomeSafety, PreviewAutomationOperation } from "@goat/contracts";
import { classifyBrowserControlReason } from "../../../preview/actionOutcomeSafety.ts";

const actions = new Set([
  "click",
  "type",
  "hover",
  "select",
  "drag",
  "press",
  "scroll",
  "upload",
  "dialog",
  "navigate",
  "back",
  "forward",
  "reload",
]);
export const previewHints = (
  operation: PreviewAutomationOperation,
  result: object,
): { next?: string } => {
  if (operation === "status" && "tabId" in result && result.tabId === null)
    return { next: "No tab yet: call goat_preview_open with a url." };
  if (operation === "snapshot" && "treeComplete" in result && result.treeComplete === false)
    return {
      next: "Narrow with interactiveOnly or scope, or read the text with goat_preview_read.",
    };
  if (
    operation === "fetch" &&
    "format" in result &&
    result.format === "raw" &&
    "truncated" in result &&
    result.truncated === true
  )
    return {
      next: "Over 25 MiB, so not saved: open the URL with goat_preview_navigate to download it.",
    };
  if (operation === "click" && "effect" in result) {
    if (result.effect === "confirmed") return {};
    if (result.effect === "suspected_noop")
      return {
        next: "Nothing changed right after the click: check with goat_preview_snapshot diff:true before retrying.",
      };
  }
  return actions.has(operation)
    ? { next: "Unconfirmed: check with goat_preview_snapshot diff:true." }
    : {};
};

const RETRY_LATER = "after two failures on one path, try another way.";

/**
 * The recovery step for a failed browser action. A refusal no retry can fix (Stop, private mode,
 * a person or another agent in control) gets none, so nothing invites another attempt.
 */
export const failureHint = (
  operation: PreviewAutomationOperation,
  error: object,
  safety: ActionOutcomeSafety,
): { next?: string } => {
  if (!actions.has(operation) || safety.code === "write_refused_terminal") return {};
  // Stop, private mode or another owner ends the attempt even when input may already be out.
  if (
    "_tag" in error &&
    error._tag === "PreviewAutomationControlInterruptedError" &&
    classifyBrowserControlReason(
      "reason" in error
        ? (error.reason as Parameters<typeof classifyBrowserControlReason>[0])
        : undefined,
    ) === "terminal"
  )
    return {};
  if ("interceptedBy" in error && typeof error.interceptedBy === "string")
    return {
      next: `Something covered the target (interceptedBy names it). Observe first in case the click landed, close or move past the cover, then retry; ${RETRY_LATER}`,
    };
  if (safety.possibleCommit)
    return {
      next: `Observe first: the input may have landed. If it did not, snapshot again before retrying; ${RETRY_LATER}`,
    };
  return { next: `Snapshot again (close any @layers blocker) before retrying; ${RETRY_LATER}` };
};

export const snapshotTransportHints = (metadata: object, truncated: boolean) =>
  truncated
    ? {
        treeComplete: false,
        omitted: [
          ...("omitted" in metadata && Array.isArray(metadata.omitted) ? metadata.omitted : []),
          "transport_budget",
        ],
        next: "Narrow with interactiveOnly or scope, or read the text with goat_preview_read.",
      }
    : {};
