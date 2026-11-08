import type { OrchestratorMcpRunFailure } from "@goat/contracts";

export const describe = (error: unknown) =>
  error instanceof Error ? error.message : typeof error === "string" ? error : String(error);

export const lastText = (texts: ReadonlyArray<string | null | undefined>) =>
  texts.findLast((text): text is string => typeof text === "string" && text.trim().length > 0) ??
  null;

const AUTH_FAILURE = /authenticat|credential|permission denied|could not read username/i;

/** One concrete next step for a run that failed before its agent started. */
export function suggestedAction(failure: OrchestratorMcpRunFailure, host: string | null): string {
  const machine = host === null ? "this machine" : host;
  if (failure.stage === "workspace_preparation") {
    if (failure.retryable === true || /timed out|no progress|stalled/i.test(failure.message))
      return `Git on ${machine} was slow or stuck, which a retry usually gets past. If the retry fails the same way, run the same git fetch in that repository on ${machine} to see whether the remote or the local repository is slow.`;
    if (AUTH_FAILURE.test(failure.message))
      return `Fix Git credentials or SSH access for that repository on ${machine}, then retry.`;
    if (/setup script/i.test(failure.message))
      return "Fix the project's setup script (its output is in the log), then retry.";
    return `Check the base ref, branch and repository named in the error on ${machine}, then retry or launch again with a corrected workspace.`;
  }
  switch (failure.errorClass) {
    case "usage_limit":
      return "The provider's usage limit is reached. Launch again after it resets, or with another model.";
    case "permission_error":
      return `The provider refused to start. Check its sign-in and permissions on ${machine}, then launch again.`;
    case "transport_error":
      return `The provider could not be reached from ${machine}. Launch again once it is reachable.`;
    case "validation_error":
      return "The provider rejected the request, often the model or its options. Launch again with a supported model.";
    default:
      return "Read the thread, then send it a new message or launch again.";
  }
}
