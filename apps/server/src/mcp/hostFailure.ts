import { OrchestratorMcpFailure, OrchestratorMcpFailureCode } from "@goat/contracts";
import * as Schema from "effect/Schema";
import type * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";

/** What a dispatch failure knows beyond its legacy code: its reason, and whether a launch ran. */
export const dispatchFacts = (error: SshRemoteDispatch.SshRemoteDispatchError) => ({
  reason: error.reason,
  ...(error.remoteCode === undefined ? {} : { remoteCode: error.remoteCode }),
  ...(error.launchMayHaveStarted === true ? { mayHaveStarted: true } : {}),
});

const isFailureCode = Schema.is(OrchestratorMcpFailureCode);

/** How an agent hears about a failed call on another machine. */
export function hostFailure(
  error: SshRemoteDispatch.SshRemoteDispatchError,
): OrchestratorMcpFailure {
  const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
    new OrchestratorMcpFailure({
      code,
      message: Array.from(message).slice(0, 2000).join(""),
      ...dispatchFacts(error),
    });
  switch (error.reason) {
    case "invalid_request":
    case "host_unknown":
      return failure("invalid_request", error.message);
    case "ssh_failed":
    case "host_unavailable":
      return failure("host_unavailable", error.message);
    case "caller_changed":
      return failure("runtime_mode_escalation_denied", error.message);
    case "remote_refused":
      return failure(
        error.remoteCode !== undefined && isFailureCode(error.remoteCode)
          ? error.remoteCode
          : "orchestration_error",
        error.message,
      );
  }
}
