import { type HandoffError, SshHostProbeError, type SshHostResult } from "@goat/contracts";
import * as Schema from "effect/Schema";

const isProbeError = Schema.is(SshHostProbeError);

export const errorResult = (
  message: string,
  code:
    | "operation_failed"
    | "invalid_request"
    | "alias_conflict"
    | "cancelled" = "operation_failed",
): SshHostResult => ({
  kind: "error",
  code,
  message: message.slice(0, 2000),
  fix: { actor: "agent", instruction: "Try again" },
});

/** What a failed SSH setup step tells its caller. */
export const setupFailure = (host: string, error: HandoffError): SshHostResult => {
  if (isProbeError(error.cause))
    return {
      kind: "error",
      code:
        error.cause.reason === "unreachable" || error.cause.reason === "connection_refused"
          ? "host_unreachable"
          : "operation_failed",
      message: error.cause.message,
      fix: { actor: "agent", instruction: "Check the SSH host and try again." },
    };
  const changed =
    error.cause !== null &&
    typeof error.cause === "object" &&
    "reason" in error.cause &&
    error.cause.reason === "host_key_changed";
  if (changed)
    return {
      kind: "error",
      code: "operation_failed",
      message: `The SSH host key for ${host} changed.`,
      status: {
        host,
        state: "failed",
        runtimeVersion: null,
        requestedVersion: "",
        failure: {
          reason: "host_key_changed",
          fix: {
            actor: "human",
            instruction: "Forget the host, then add it again to review its new fingerprint.",
            path: "ssh.host_forget",
          },
        },
      },
    };
  return errorResult(
    `${host}: ${error.message}`,
    error.reason === "invalid_request"
      ? "invalid_request"
      : error.reason === "conflict"
        ? "alias_conflict"
        : error.reason === "expired"
          ? "cancelled"
          : "operation_failed",
  );
};
