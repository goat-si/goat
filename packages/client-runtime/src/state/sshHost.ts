import {
  WS_METHODS,
  type EnvironmentId,
  type SshHostResult,
  type SshHostProbeError,
  type SshHandoffProgressResult,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createCommandPermissions } from "./commandPermissions.ts";
import { createEnvironmentQueryAtomFamily, createEnvironmentRpcCommand } from "./runtime.ts";
import type { AtomCommand } from "./runtime.ts";
import { createEnvironmentSessionAtoms } from "./session.ts";
import { sshRuntimeRecoveryText, sshRuntimeStatusText } from "./sshRuntime.ts";

/** Present probe failures using the requested SSH port, without parsing SSH diagnostics. */
export function sshHostProbeErrorText(error: SshHostProbeError, port: number) {
  switch (error.reason) {
    case "unreachable":
      return `Can't reach ${error.host}. Check the address and that SSH is running, then try again.`;
    case "connection_refused":
      return `${error.host} refused the connection on port ${port}. Check the SSH port, then try again.`;
    case "alias_conflict":
      return `${error.host} is already used by another SSH host. Pick a different name.`;
    case "invalid_request":
    case "operation_failed":
      return error.message;
  }
}

/** Visible clients own the timer; ready runtime with pending diagnosis is still running setup. */
export function sshHostPollDelay(result: SshHostResult | undefined, awaitingContinuation = false) {
  if (result?.kind === "error") return null;
  const status = result?.status;
  if (
    awaitingContinuation &&
    status?.setup?.stage === "runtime" &&
    (status.state === "untrusted" || status.state === "trust_pending" || status.state === "stopped")
  )
    return 1_000;
  if (
    status?.state === "preparing" ||
    (status?.state === "ready" && status.setup !== undefined && status.setup.stage !== "complete")
  )
    return 1_000;
  return status?.state === "update_waiting" ? 10_000 : null;
}

/** Never infer completion from a previous diagnosis, or from an approval alone. */
export function sshHostProgressComplete(progress: SshHandoffProgressResult) {
  if (progress.kind !== "available" || progress.result.kind !== "ok") return false;
  const status = progress.result.status;
  return (
    status.state === "ready" &&
    status.setup?.stage === "complete" &&
    status.setup.operationId === progress.operationId &&
    status.setup.generation === progress.generation
  );
}

export function sshHostProgressText(progress: SshHandoffProgressResult) {
  if (progress.kind === "unavailable")
    return progress.reason === "not_ssh"
      ? null
      : "This request expired or was replaced. Ask the agent again.";
  const result = progress.result;
  if (result.kind === "error")
    return result.code === "host_unreachable"
      ? `Can't reach ${progress.host}. Check that it's running and reachable, then try again.`
      : result.message;
  if (
    result.kind === "ok" &&
    result.status.setup === undefined &&
    !["failed", "untrusted", "trust_pending"].includes(result.status.state)
  )
    return "Host key pinned. The agent can continue.";
  if (result.status.state === "ready" && result.status.setup?.stage === "diagnosis")
    return "Runtime ready · Checking providers";
  return sshRuntimeStatusText(result.status);
}

export function sshHostProgressRecovery(progress: SshHandoffProgressResult) {
  return progress.kind === "available" && progress.result.status !== undefined
    ? sshRuntimeRecoveryText(progress.result.status)
    : null;
}

/** Server aliases and durable handoff bindings belong to the authenticated origin, never Desktop IPC. */
export function createSshHostState<R, E>(runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>) {
  const sessions = createEnvironmentSessionAtoms(runtime);
  const statusCommand = createEnvironmentRpcCommand(runtime, {
    label: "sshHost.status",
    tag: WS_METHODS.sshHostStatus,
  });
  const progressCommand = createEnvironmentRpcCommand(runtime, {
    label: "sshHost.handoffProgress",
    tag: WS_METHODS.sshHostHandoffProgress,
  });
  const operate = createCommandPermissions(runtime, WS_METHODS.handoffsRespond);
  const settings = createCommandPermissions(runtime, WS_METHODS.sshHostTrust);
  const maintain = createCommandPermissions(runtime, WS_METHODS.sshHostPrepare);
  const progressPermissions = Atom.family((key: string) => {
    const [environmentId, path] = JSON.parse(key) as [EnvironmentId, string];
    return Atom.make(
      (get) =>
        get(progressCommand.permissionAtom(environmentId)) &&
        get(operate.permissionAtom(environmentId)) &&
        get(
          (["ssh.host_add", "ssh.host_forget"].includes(path) ? settings : maintain).permissionAtom(
            environmentId,
          ),
        ),
    );
  });
  const progressPermissionAtom = (environmentId: EnvironmentId, targetPath: string) =>
    progressPermissions(JSON.stringify([environmentId, targetPath]));

  // The generic RPC query helper excludes guarded methods. Use its underlying query
  // factory with a guarded command, keeping transport access inside rpc/.
  function guardedQuery<Input, A, Failure>(
    command: AtomCommand<
      { readonly environmentId: EnvironmentId; readonly input: Input },
      A,
      Failure
    >,
    label: string,
    permission: (environmentId: EnvironmentId, targetPath: string) => Atom.Atom<boolean>,
  ) {
    const query = createEnvironmentQueryAtomFamily<
      R,
      E,
      { environmentId: EnvironmentId; payload: Input; epoch: string },
      A,
      Failure
    >(runtime, {
      label,
      idleTtlMs: 0,
      staleTimeMs: 0,
      execute: (input: { environmentId: EnvironmentId; payload: Input; epoch: string }, _emit) =>
        Effect.gen(function* () {
          const registry = yield* AtomRegistry.AtomRegistry;
          const outcome = yield* Effect.promise(() =>
            command.run(registry, {
              environmentId: input.environmentId,
              input: input.payload,
            }),
          );
          return outcome._tag === "Success"
            ? outcome.value
            : yield* Effect.failCause(outcome.cause);
        }),
    });
    const family = Atom.family((key: string) => {
      const target = JSON.parse(key) as {
        environmentId: EnvironmentId;
        input: Input;
        targetPath: string;
      };
      const lifetimes = new WeakMap<
        AtomRegistry.AtomRegistry,
        { allowed: boolean; prepared: unknown; session: unknown; generation: number }
      >();
      const selected = Atom.make((get) => {
        const allowed = get(permission(target.environmentId, target.targetPath));
        const prepared = get(sessions.preparedConnectionValueAtom(target.environmentId));
        const sessionResult = get(sessions.sessionStateAtom(target.environmentId));
        const session = Option.getOrNull(AsyncResult.value(sessionResult));
        const connection = Option.getOrNull(prepared);
        const previous = lifetimes.get(get.registry);
        const generation =
          previous === undefined
            ? 0
            : previous.generation +
              Number(
                previous.allowed !== allowed ||
                  previous.prepared !== connection ||
                  previous.session !== session,
              );
        lifetimes.set(get.registry, { allowed, prepared: connection, session, generation });
        if (!allowed || connection === null || session === null || sessionResult._tag === "Failure")
          return null;
        return query({
          environmentId: target.environmentId,
          input: {
            environmentId: target.environmentId,
            payload: target.input,
            epoch: String(generation),
          },
        });
      }).pipe(Atom.setIdleTTL(0));
      const atom = Atom.make((get) => {
        const active = get(selected);
        return active === null ? AsyncResult.initial<A, Failure>() : get(active);
      }).pipe(Atom.setIdleTTL(0));
      return { atom, selected };
    });
    const select = (target: { environmentId: EnvironmentId; input: Input; targetPath?: string }) =>
      family(JSON.stringify({ ...target, targetPath: target.targetPath ?? "" }));
    return {
      query: (target: { environmentId: EnvironmentId; input: Input; targetPath?: string }) =>
        select(target).atom,
      refresh: (
        registry: AtomRegistry.AtomRegistry,
        target: { environmentId: EnvironmentId; input: Input; targetPath?: string },
      ) => {
        const active = registry.get(select(target).selected);
        if (active !== null) registry.refresh(active);
      },
    };
  }
  const status = guardedQuery(statusCommand, "sshHost.status.query", (id) =>
    statusCommand.permissionAtom(id),
  );
  const handoffProgress = guardedQuery(
    progressCommand,
    "sshHost.progress.query",
    progressPermissionAtom,
  );
  return {
    status: status.query,
    refreshStatus: status.refresh,
    handoffProgress: handoffProgress.query,
    refreshHandoffProgress: handoffProgress.refresh,
    statusPermissionAtom: statusCommand.permissionAtom,
    progressPermissionAtom,
  };
}
