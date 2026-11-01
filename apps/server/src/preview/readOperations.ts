import type { PreviewAutomationRequest } from "@goat/contracts";
/** Read-only operations remain available during human control; evaluate requires control because scripts can mutate the page. */
export const READ_OPERATIONS: ReadonlySet<PreviewAutomationRequest["operation"]> = new Set([
  "status",
  "snapshot",
  "logs",
  "read",
  "waitFor",
  "signInState",
]);

// Status reports state, while close and recordingStop let the agent end resources.
export const FENCED_ALLOWED_OPERATIONS: ReadonlySet<PreviewAutomationRequest["operation"]> =
  new Set(["status", "close", "recordingStop"]);
