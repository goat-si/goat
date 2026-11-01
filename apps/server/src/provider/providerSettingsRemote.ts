import { OrchestratorMcpFailure } from "@goat/contracts";
import * as Schema from "effect/Schema";

import * as Dispatch from "../sshRemote/SshRemoteDispatch.ts";

const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });
const isMcpFailure = Schema.is(OrchestratorMcpFailure);

/**
 * How a provider settings write forwarded to another host fails. A host too old to have the
 * tool keeps remote_outdated, so goat_call reports failed_precondition rather than internal.
 */
export const remoteFailure = (tool: string, host: string) => (error: unknown) =>
  error instanceof Dispatch.SshRemoteDispatchError
    ? failure(
        error.reason === "invalid_request" || error.reason === "host_unknown"
          ? "invalid_request"
          : error.reason === "remote_outdated"
            ? "remote_outdated"
            : "orchestration_error",
        Dispatch.refusedByRemote(error.reason) && error.remoteCode === undefined
          ? `${host} refused ${tool}: ${error.message} Update GOAT there if it does not have this tool yet.`
          : error.message,
      )
    : isMcpFailure(error)
      ? error
      : failure("orchestration_error", `Could not reach ${host}.`);

/**
 * The remote may have applied the change: the call failed after its request could have
 * arrived, so nothing proves it did not run there.
 */
export const mayHaveReached = (error: unknown): error is Dispatch.SshRemoteDispatchError =>
  error instanceof Dispatch.SshRemoteDispatchError &&
  (error.launchMayHaveStarted === true ||
    error.reason === "ssh_failed" ||
    error.reason === "host_unavailable");
