import type { PreviewAutomationOperation } from "@goat/contracts";

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
