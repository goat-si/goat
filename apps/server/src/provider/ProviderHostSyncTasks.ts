import {
  type EnvironmentAuthorizationError,
  type ProviderHostSyncDriver,
  ProviderHostSyncError,
  type ProviderSyncHostState,
  type ProviderSyncLogin,
  type ProviderSyncResult,
  type ProviderSyncState,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";

import * as Dispatch from "../sshRemote/SshRemoteDispatch.ts";

export type Failure = ProviderHostSyncError | EnvironmentAuthorizationError;
export const fail = (code: ProviderHostSyncError["code"], detail: string) =>
  new ProviderHostSyncError({ code, detail });

/** How a remote call failed, in the words a person acts on. */
export type RemoteFailure = {
  readonly status: "update_runtime" | "not_ready" | "unreachable" | "refused";
  readonly message: string;
};
export const classify = (error: Dispatch.SshRemoteDispatchError | Failure): RemoteFailure => {
  const message = error.message;
  if (error._tag !== "SshRemoteDispatchError") return { status: "refused", message };
  if (Dispatch.refusedByRemote(error.reason) && message.includes(" does not have "))
    return { status: "update_runtime", message };
  if (error.reason === "host_unavailable" && message.includes("goat_ssh_host_prepare"))
    return { status: "not_ready", message };
  if (error.reason === "remote_refused" || error.reason === "caller_changed")
    return { status: "refused", message };
  return { status: "unreachable", message };
};

export type StatePatch = Partial<Omit<ProviderSyncHostState, "login" | "message">> & {
  readonly message?: string;
  readonly login?: ProviderSyncLogin | undefined;
};
export interface HostTask {
  state: ProviderSyncHostState;
  finished: boolean;
  remoteSyncId?: string;
  /** The call that starts a remote sync; a cancel waits for it to learn the remote sync id. */
  starting?: Fiber.Fiber<ProviderSyncResult, RemoteFailure>;
  onFinished?: Effect.Effect<void>;
}
export interface SyncOperation {
  readonly syncId: string;
  readonly driver: ProviderHostSyncDriver;
  readonly version: string | null;
  readonly login: boolean;
  readonly startedAt: string;
  readonly startedAtMs: number;
  readonly hosts: Array<HostTask>;
  /** Callers who may cancel and see sign-in codes: requester, approver, outside client. */
  readonly owners: Set<string>;
  fibers: Array<Fiber.Fiber<unknown, unknown>>;
  /** Approvals that record this sync's result when its last host finishes. */
  readonly settlers: Array<(state: ProviderSyncState) => Effect.Effect<void>>;
}

export const update = (task: HostTask, next: StatePatch, finished = false) =>
  Effect.suspend(() => {
    const { login, message, ...rest } = next;
    const base = { ...task.state, ...rest };
    const withMessage =
      message === undefined ? (({ message: _m, ...state }) => state)(base) : { ...base, message };
    task.state =
      "login" in next
        ? login === undefined
          ? (({ login: _l, ...state }) => state)(withMessage)
          : { ...withMessage, login }
        : withMessage;
    if (!finished) return Effect.void;
    task.finished = true;
    return task.onFinished ?? Effect.void;
  });
