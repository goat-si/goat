import {
  type EnvironmentAuthorizationError,
  type HandoffError,
  type ProviderHostRow,
  type ProviderHostSyncDriver,
  ProviderHostSyncError,
  type ProviderSyncHostState,
  type ProviderSyncLogin,
  type ProviderSyncResult,
  type ProviderSyncState,
} from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";

import * as Dispatch from "../sshRemote/SshRemoteDispatch.ts";
import { quoteRemote } from "../sshRemote/remoteText.ts";
import { describeInstall, installCommand, trustedLogin } from "./ProviderHostSyncRecipes.ts";
import type { SshHostCaller } from "../sshRemote/SshHostAuthorization.ts";

export type Failure = ProviderHostSyncError | EnvironmentAuthorizationError;

export const ownerSession = (caller: SshHostCaller): string =>
  caller.kind === "client" ? caller.sessionId : (caller.scope.client?.sessionId ?? "mcp");

/** Who a caller is for owning a sync: its thread, else its client session. */
export const callerKey = (caller: SshHostCaller): string =>
  caller.kind === "client"
    ? `session:${caller.sessionId}`
    : caller.scope.thread !== undefined
      ? `thread:${caller.scope.thread.threadId}`
      : `session:${caller.scope.client?.sessionId ?? "unknown"}`;

export const fail = (code: ProviderHostSyncError["code"], detail: string) =>
  new ProviderHostSyncError({ code, detail });
/** A failed ask keeps the hold's words, so the agent learns which card it waits on. */
export const askFailed = (error: HandoffError) =>
  error.reason === "limit_reached"
    ? fail("invalid_request", error.message)
    : fail("unavailable", "Could not ask for approval. Try again.");

/** How a remote call failed, in the words a person acts on. */
export type RemoteFailure = {
  readonly status: "update_runtime" | "not_ready" | "unreachable" | "refused";
  readonly message: string;
  /** The call never reached the remote, so no sync can be running there for it. */
  readonly unsent?: true;
};
export const classify = (error: Dispatch.SshRemoteDispatchError | Failure): RemoteFailure => {
  const failure = describe(error);
  // Only a refusal here or a request that never left is definite. Anything the remote answered,
  // a refusal or "unknown tool" included, may come after it started the sync.
  const unsent =
    error._tag !== "SshRemoteDispatchError" ||
    error.reason === "invalid_request" ||
    error.reason === "host_unknown";
  return unsent ? { ...failure, unsent: true } : failure;
};
const describe = (error: Dispatch.SshRemoteDispatchError | Failure): RemoteFailure => {
  const message = error.message;
  if (error._tag !== "SshRemoteDispatchError") return { status: "refused", message };
  // From the structured reason only: a remote's own text could say anything.
  if (error.reason === "remote_outdated") return { status: "update_runtime", message };
  if (error.reason === "host_unavailable" && message.includes("goat_ssh_host_prepare"))
    return { status: "not_ready", message };
  if (error.reason === "remote_refused")
    // Room for the note lostTrack may add, within the 1,024-character message limit.
    return { status: "refused", message: quoteRemote("The host answered: ", message, 800) };
  if (error.reason === "caller_changed") return { status: "refused", message };
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
  /** A cancel owns this host's final state; an interrupted run must not finish it. */
  cancelling?: boolean;
  /** Finished without knowing how its remote sync ended; a later cancel may reopen it. */
  mayStillRun?: boolean;
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
  /** Done once every host finished and the settlers ran, cancels included. */
  readonly allFinished: Deferred.Deferred<void>;
  /** The one cancel that owns every host it claimed; a later cancel joins it. */
  cancelling?: Fiber.Fiber<void> | undefined;
  /** Approvals that record this sync's result when its last host finishes. */
  readonly settlers: Array<(state: ProviderSyncState) => Effect.Effect<void>>;
}

/** A finished host's state is final: a late writer, such as a second cancel, changes nothing. */
export const update = (task: HostTask, next: StatePatch, finished = false) =>
  Effect.suspend(() => {
    if (task.finished) return Effect.void;
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

const unconfirmed = (host: string): StatePatch => ({
  phase: "failed",
  login: undefined,
  message: `Could not confirm the cancel on ${host}; its installer may still be running. Check goat_provider_host_matrix.`,
});

/** A remote start a cancel waited on: its sync id, null when nothing runs there, undefined when unknown. */
const startOutcome = (exit: Exit.Exit<ProviderSyncResult, RemoteFailure>) => {
  if (Exit.isSuccess(exit)) return exit.value.kind === "started" ? exit.value.sync.syncId : null;
  const failure = Cause.findErrorOption(exit.cause);
  return Option.isSome(failure) && failure.value.unsent === true ? null : undefined;
};

/** What a cancel may say about a remote host: only what it confirmed, else undefined. */
const afterRemoteCancel = <E>(
  request: RemoteRequest,
  host: string,
  reply: Exit.Exit<ProviderSyncState, E>,
) => {
  const remote = Exit.isSuccess(reply) ? reply.value.hosts[0] : undefined;
  if (remote?.phase === "cancelled") return { phase: "cancelled", login: undefined } as const;
  // It finished there before the cancel arrived.
  if (Exit.isSuccess(reply) && reply.value.done && remote !== undefined)
    return { ...remoteHostState(request, remote, host), login: undefined };
  return undefined;
};

/**
 * Ends a remote host whose sync Home can no longer follow. A sync that started may still be
 * running, so the host stays cancellable; a start whose reply was lost may have run, with no id
 * to cancel, so the host says to check that machine.
 */
export const lostTrack = (
  task: HostTask,
  message: string,
  options: { readonly phase?: "failed" | "update_runtime"; readonly unsent?: boolean } = {},
) =>
  Effect.suspend(() => {
    const phase = options.phase ?? "failed";
    if (task.remoteSyncId !== undefined) {
      task.mayStillRun = true;
      return update(
        task,
        {
          phase,
          message: `${message} Its installer may still be running there; cancel this sync to stop it.`,
        },
        true,
      );
    }
    if (options.unsent === true) return update(task, { phase, message }, true);
    return update(
      task,
      {
        phase,
        message: `${message} It may have started installing there; goat_provider_host_matrix shows whether the CLI is installed, not whether that install is still running.`,
      },
      true,
    );
  });

/**
 * Cancels one claimed host. A remote one is cancelled there and reported as that host
 * confirms; a start whose fate is unknown is reported unconfirmed.
 */
export const cancelTask = Effect.fn("ProviderHostSync.cancelTask")(function* <E>(
  task: HostTask,
  request: RemoteRequest,
  cancelRemote: (host: string, syncId: string) => Effect.Effect<ProviderSyncState, E>,
) {
  if (task.finished) return;
  const host = task.state.host;
  const syncId =
    task.remoteSyncId ??
    (task.starting === undefined ? null : startOutcome(yield* Fiber.await(task.starting)));
  if (host === null || syncId === null)
    return yield* update(task, { phase: "cancelled", login: undefined }, true);
  if (syncId === undefined) return yield* update(task, unconfirmed(host), true);
  const confirmed = afterRemoteCancel(
    request,
    host,
    yield* Effect.exit(cancelRemote(host, syncId)),
  );
  if (confirmed !== undefined) return yield* update(task, confirmed, true);
  task.remoteSyncId = syncId;
  task.mayStillRun = true;
  yield* update(task, unconfirmed(host), true);
});

/** Whatever stopped a cancel, each host it claimed ends: cancelled here, unconfirmed elsewhere. */
const finishClaimed = (tasks: ReadonlyArray<HostTask>) =>
  Effect.forEach(
    tasks,
    (task) =>
      update(
        task,
        task.state.host === null
          ? { phase: "cancelled", login: undefined }
          : unconfirmed(task.state.host),
        true,
      ),
    { discard: true },
  );

/**
 * The cancel of a sync, owned by the service scope. Claiming its hosts and starting it is one
 * step, so a caller that goes away cannot leave a claimed host without its cancel. A cancel that
 * arrives while one runs joins it; a later one retries hosts that may still be running.
 */
export const claimCancel = (
  operation: SyncOperation,
  scope: Scope.Scope,
  stop: (claimed: ReadonlyArray<HostTask>) => Effect.Effect<void>,
) =>
  Effect.uninterruptible(
    Effect.suspend(() => {
      if (operation.cancelling !== undefined) return Effect.succeed(operation.cancelling);
      const claimed = operation.hosts.filter((task) => !task.finished || task.mayStillRun);
      for (const task of claimed) {
        // Reopened: its earlier result stays recorded, and this cancel writes the final one.
        task.finished = false;
        task.mayStillRun = false;
        task.cancelling = true;
      }
      const run = stop(claimed).pipe(
        Effect.interruptible,
        Effect.ensuring(finishClaimed(claimed)),
        // A later cancel may retry a host this one could not confirm.
        Effect.ensuring(
          Effect.sync(() => {
            operation.cancelling = undefined;
          }),
        ),
      );
      return Effect.forkIn(run, scope).pipe(
        Effect.tap((fiber) =>
          Effect.sync(() => {
            operation.cancelling = fiber;
          }),
        ),
      );
    }),
  );

/** A later cancel can reopen finished hosts, set in the step that reopens them: wait out each. */
export const cancelsSettled = (operation: SyncOperation): Effect.Effect<void> =>
  Effect.suspend(() =>
    operation.cancelling === undefined
      ? Effect.void
      : Fiber.await(operation.cancelling).pipe(Effect.andThen(cancelsSettled(operation))),
  );

/**
 * A remote host's sync state as this machine shows it. Its `ran` and `message` are text from
 * another machine: `ran` is kept only when it is one of GOAT's own recipe lines for this request,
 * and `message` is quoted under the host's name.
 */
type RemoteRequest = { readonly driver: ProviderHostSyncDriver; readonly version: string | null };

/**
 * Why GOAT will not ask `host` to install `driver`, read from that host's own matrix row. A host
 * that does not say its installs are verified may pipe a vendor script into a shell, unless the
 * recipe it reports for this driver is npm, which every GOAT release runs at the given version.
 */
export const unverifiedRemote = (
  row: ProviderHostRow,
  driver: ProviderHostSyncDriver,
  name: string,
): Pick<ProviderSyncHostState, "phase" | "message"> | undefined => {
  const host = row.host ?? "that machine";
  if (row.status !== "ok")
    return {
      phase: row.status === "update_runtime" ? "update_runtime" : "failed",
      message: row.message ?? `GOAT could not read what ${host} installs with.`,
    };
  const reported = row.providers.find((provider) => provider.driver === driver);
  if (row.installs === "verified" || reported?.installMethod === "npm") return undefined;
  return {
    phase: "update_runtime",
    message: `GOAT on ${host} predates pinned, verified installs, so nothing was installed there. Update GOAT on ${host}, or install ${name} there by hand.`,
  };
};

export const remoteHostState = (
  request: RemoteRequest,
  remote: ProviderSyncHostState,
  host: string,
) => {
  const { ran, message, login, ...rest } = remote;
  const recipe = (["darwin", "linux", "win32"] as const).some((platform) => {
    const command = installCommand(request.driver, platform, request.version);
    return command !== null && describeInstall(command) === ran;
  });
  return {
    ...rest,
    host,
    ...(ran !== undefined && recipe ? { ran } : {}),
    // Another machine's words, quoted under its name so they never read as GOAT's own.
    ...(message === undefined ? {} : { message: quoteRemote(`${host} reports: `, message, 1_024) }),
    ...(login === undefined ? {} : { login: trustedLogin(request.driver, host, login) }),
  };
};
