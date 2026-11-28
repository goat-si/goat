import type { GoatMcpToolDefinition } from "./goatMcpToolPresentation.ts";

export const lifecycleToolDefinitions = (
  tool: (
    labels: GoatMcpToolDefinition["labels"],
    summaryAction: GoatMcpToolDefinition["summaryAction"],
  ) => GoatMcpToolDefinition,
) => ({
  goat_queue_resume: tool(
    ["Resume", "Resuming", "Requested resumption of", "a thread queue"],
    "thread-update",
  ),
  goat_queue_receipt: tool(
    ["Read", "Reading", "Read", "a queue resumption receipt"],
    "thread-read",
  ),
  goat_queued_run_start: tool(
    ["Start", "Starting", "Requested a start of", "a queued run"],
    "thread-update",
  ),
  goat_queued_run_receipt: tool(
    ["Read", "Reading", "Read", "a queued run start receipt"],
    "thread-read",
  ),
  goat_thread_delete: tool(
    ["Delete", "Deleting", "Requested deletion of", "an inactive thread"],
    "thread-update",
  ),
  goat_thread_lifecycle_receipt: tool(
    ["Read", "Reading", "Read", "a thread deletion receipt"],
    "thread-read",
  ),
  goat_provider_session_detach: tool(
    ["Disconnect", "Disconnecting", "Requested disconnection of", "a provider session"],
    "thread-update",
  ),
  goat_provider_session_receipt: tool(
    ["Read", "Reading", "Read", "a provider session disconnection receipt"],
    "thread-read",
  ),
});
