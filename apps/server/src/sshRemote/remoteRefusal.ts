import type { SshDispatchFailureReason } from "@goat/contracts";

/** The remote answered and refused, including because it has no such tool. Nothing ran there. */
export const refusedByRemote = (reason: SshDispatchFailureReason) =>
  reason === "remote_refused" || reason === "remote_outdated";
