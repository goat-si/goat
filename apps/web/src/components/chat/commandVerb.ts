import type { liveActivityToolStatus } from "@goat/client-runtime/work-log/presentation";

const COMMAND_VERBS: Partial<Record<ReturnType<typeof liveActivityToolStatus>, string>> = {
  inProgress: "Running",
  failed: "Failed",
  declined: "Declined",
  stopped: "Stopped",
};

/** The verb a command row leads with, like Codex's "Ran …" and "Running …". */
export function commandVerb(status: ReturnType<typeof liveActivityToolStatus>): string {
  return COMMAND_VERBS[status] ?? "Ran";
}
