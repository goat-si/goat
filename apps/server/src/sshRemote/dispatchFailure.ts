import type { SshDispatchFailureReason } from "@goat/contracts";
import type * as NetService from "@goat/shared/Net";
import type * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type { HttpClient } from "effect/http";
import type { ChildProcessSpawner } from "effect/process";

export class SshRemoteDispatchError extends Data.TaggedError("SshRemoteDispatchError")<{
  /**
   * host_unavailable: unreachable or no answer in time. remote_refused: the remote refused
   * (remoteCode carries its code). remote_outdated: no such tool there, so nothing ran.
   * caller_changed: the caller's modes changed while the call was in flight.
   */
  readonly reason: SshDispatchFailureReason;
  readonly message: string;
  readonly remoteCode?: string | undefined;
  readonly launchMayHaveStarted?: boolean | undefined;
  /** A placement answer's classification (placement_not_started, placement_full, ...). */
  readonly remoteClassification?: string | undefined;
  /** The idle thread a not-started placement left on the remote. */
  readonly remoteThreadId?: string | undefined;
}> {}

/**
 * remoteCode on a refusal before any launch because the remote cannot verify or apply a task
 * memory ceiling (an older GOAT). Callers that must not run without the grant fail on it.
 */
export const MEMORY_CEILING_UNSUPPORTED = "memory_ceiling_unsupported";

/** remoteClassification when the launching session does not declare placement; nothing was sent. */
export const PLACEMENT_UNSUPPORTED = "placement_unsupported";

export const memoryRefusal = (message: string) =>
  new SshRemoteDispatchError({
    reason: "remote_refused",
    message,
    remoteCode: MEMORY_CEILING_UNSUPPORTED,
  });

export const failure = (reason: SshRemoteDispatchError["reason"], message: string, facts = {}) =>
  new SshRemoteDispatchError({ reason, message, ...facts });

export const describe = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = String((error as { readonly message: unknown }).message).trim();
    if (message.length > 0) return message;
  }
  return String(error);
};

/** The platform services every SSH operation runs with. */
export type RuntimeServices =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
  | NetService.NetService;
