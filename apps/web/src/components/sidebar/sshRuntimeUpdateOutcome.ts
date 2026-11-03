import type { SshHostStatus } from "@goat/contracts";
import type { ServerUpdateOutcome } from "../ServerUpdateAction";

export function sshRuntimeUpdateOutcome(
  status: SshHostStatus | undefined,
): ServerUpdateOutcome | null {
  if (status?.state === "failed")
    return { status: "failed", message: status.failure?.reason ?? "The runtime update failed." };
  if (status?.state === "ready" || status?.state === "providers_not_ready") {
    if (status.runtimeVersion === status.requestedVersion) return { status: "updated" };
    return {
      status: "failed",
      message: status.detail ?? `Still on ${status.runtimeVersion ?? "an older runtime"}`,
    };
  }
  if (status?.state === "update_blocked")
    return { status: "failed", message: "Another GOAT server is running on that host." };
  return null;
}
