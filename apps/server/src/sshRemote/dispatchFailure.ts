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
  /** Arguments a remote refused goat_thread_launch for before creating anything; nothing ran. */
  readonly undeclaredArguments?: ReadonlyArray<string> | undefined;
  /** A placement answer's classification (placement_not_started, placement_full, ...). */
  readonly remoteClassification?: string | undefined;
  /** The idle thread a not-started placement left on the remote. */
  readonly remoteThreadId?: string | undefined;
  /** With a provider_cli_missing classification: the driver provider.sync installs there. */
  readonly remoteDriver?: string | undefined;
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

/**
 * The arguments a remote says goat_thread_launch does not take, so nothing ran: GOAT's admission
 * refusal of undeclared arguments (invalid_request), or an older schema's own invalid-params
 * message, each before the handler and starting with that sentence. Bare text, another code or
 * error, a may-have-started answer, or the sentence anywhere else may follow a create.
 */
export const undeclaredLaunchArguments = (
  tool: string,
  said: {
    readonly message?: string | undefined;
    readonly rpcCode?: number | undefined;
    readonly code?: string | undefined;
    readonly mayHaveStarted?: boolean | undefined;
  },
): ReadonlyArray<string> | undefined => {
  if (tool !== "goat_thread_launch" || said.mayHaveStarted === true) return undefined;
  if (said.rpcCode !== -32602 && said.code !== "invalid_request") return undefined;
  const named = /^goat_thread_launch does not take (\w+(?:, \w+)*), so nothing ran/u.exec(
    said.message ?? "",
  );
  return named?.[1]?.split(", ");
};

/** What a failed call says of a launch: the RPC error's own message, never its data. */
export const rpcLaunchFacts = (
  tool: string,
  error: {
    readonly rpcCode?: number | undefined;
    readonly rpcMessage?: string | undefined;
    readonly rpcMayHaveStarted?: boolean | undefined;
  },
) => {
  const undeclared = undeclaredLaunchArguments(tool, {
    rpcCode: error.rpcCode,
    message: error.rpcMessage,
    mayHaveStarted: error.rpcMayHaveStarted,
  });
  if (undeclared !== undefined) return { undeclaredArguments: undeclared };
  return tool === "goat_thread_launch" ? { launchMayHaveStarted: true } : {};
};

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
