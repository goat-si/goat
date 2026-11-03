import type { OrchestrationV2ProviderThread } from "@goat/contracts";
/** A registered cloud task whose first run has not started: that run attaches, never submits. */
export const isRegisteredAttach = (thread: OrchestrationV2ProviderThread | undefined) =>
  thread?.cloudTask?.attach === "registered" &&
  thread.firstRunOrdinal === null &&
  thread.nativeThreadRef !== null &&
  (thread.cloudTask.status === "running" || thread.cloudTask.status === "submitting");
