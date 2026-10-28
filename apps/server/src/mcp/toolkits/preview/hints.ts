import type { ActionOutcomeSafety, PreviewAutomationOperation } from "@goat/contracts";

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
  if (safety.possibleCommit)
    return {
      next: `Observe first: the input may have landed. If it did not, snapshot again before retrying; ${RETRY_LATER}`,
    };
  if ("interceptedBy" in error && typeof error.interceptedBy === "string")
    return {
      next: `Something covers the target: snapshot again, close the blocker its @layers line names, then retry; ${RETRY_LATER}`,
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
