import type { PreviewAutomationRequest } from "@goat/contracts";
/** Read-only operations remain available during human control; evaluate requires control because scripts can mutate the page. */
export const READ_OPERATIONS: ReadonlySet<PreviewAutomationRequest["operation"]> = new Set([
  "status",
  "snapshot",
  "logs",
  "fetch",
  "read",
  "waitFor",
  "signInState",
]);
