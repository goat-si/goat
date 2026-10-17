import type {
  DesktopSshEnvironmentTarget,
  EnvironmentId,
  SshHostResult,
  SshHostStatus,
  SshRuntimeUpdateMode,
} from "@goat/contracts";
import { compareRuntimeBuilds } from "@goat/shared/semver";
import * as Effect from "effect/Effect";
import { Atom, type AtomRegistry } from "effect/reactivity";

import { createRuntimeCommand } from "./runtime.ts";

export interface SshRuntimeOwnerGateway {
  readonly status: (target: DesktopSshEnvironmentTarget) => Effect.Effect<SshHostResult>;
  readonly update: (
    target: DesktopSshEnvironmentTarget,
    mode: SshRuntimeUpdateMode,
  ) => Effect.Effect<SshHostResult>;
}

export interface SshRuntimeTarget {
  readonly environmentId: EnvironmentId;
  readonly target: DesktopSshEnvironmentTarget;
}

interface SshRuntimeCommandInput extends SshRuntimeTarget {
  readonly generation: number;
  readonly mode?: SshRuntimeUpdateMode;
}

/** Scope the owner cache to a saved environment and its normalized SSH route. */
export function sshRuntimeTargetKey({ environmentId, target }: SshRuntimeTarget) {
  return JSON.stringify([
    environmentId,
    target.alias.trim(),
    target.hostname.trim().toLowerCase(),
    target.username?.trim() || null,
    target.port ?? 22,
  ]);
}

function archivePlatform(key: string | null | undefined) {
  if (!key) return "this platform";
  const match = /^(linux|darwin|win32|windows)[-_](.+)$/.exec(key);
  if (!match) return key;
  const os = match[1] === "darwin" ? "macOS" : match[1] === "linux" ? "Linux" : "Windows";
  return `${os} (${match[2]})`;
}

/** Copy shared by the saved connection subtitle and its runtime details. */
export function sshRuntimeStatusText(status: SshHostStatus): string {
  const version = status.runtimeVersion ?? "unknown";
  switch (status.state) {
    case "untrusted":
      return "Host fingerprint approval needed";
    case "trust_pending":
      return "Waiting for host fingerprint approval";
    case "auth_failed":
      return "SSH key authentication failed";
    case "preparing": {
      switch (status.phase) {
        case "connecting":
          return "Connecting";
        case "checking":
          return "Checking GOAT runtime";
        case "uploading":
          return "Uploading GOAT runtime (about 70 MB)";
        case "starting":
          return "Starting GOAT";
        case undefined:
          return "Starting setup";
      }
      const phase: never = status.phase;
      return phase;
    }
    case "stopped":
      return `Not running · Runtime ${version}`;
    case "ready":
      return `${status.runtimeVersion === status.requestedVersion ? "Up to date" : "Update available"} · Runtime ${version}`;
    case "update_waiting":
      return `Update waits for running work · Runtime ${version}`;
    case "update_blocked": {
      const order =
        status.runtimeVersion === null
          ? undefined
          : compareRuntimeBuilds(
              { version: status.runtimeVersion },
              { version: status.requestedVersion },
            );
      return order !== undefined && order > 0
        ? `${status.host} runs a newer GOAT (${version}). Update this app from the update button above Settings.`
        : `A GOAT server that this app didn't start is running on ${status.host}. Stop it on the host, then reconnect.`;
    }
    case "providers_not_ready":
      return `Providers need attention · Runtime ${version}`;
    case "failed": {
      const failure = status.failure;
      if (!failure) return status.detail ?? `GOAT setup failed on ${status.host}.`;
      switch (failure.reason) {
        case "archive_unavailable":
          return `GOAT ${failure.archive?.requestedVersion ?? status.requestedVersion} for ${archivePlatform(failure.archive?.platformKey)} isn't available to install.`;
        case "host_key_changed":
          return `The host key for ${status.host} changed, so GOAT stopped connecting. If you rebuilt this server, forget it and add it again.`;
        case "start_timeout":
          return `GOAT didn't start on ${status.host} in time. Try again; if it repeats, check the host's server.log.`;
        case "missing_tools":
          return (
            status.detail ??
            `${status.host} is missing required tools. Install them on the host, then try again.`
          );
        case "unsupported_platform":
          return (
            status.detail ??
            "GOAT's server doesn't run on Intel Macs. Use Linux, an Apple Silicon Mac, or Windows."
          );
      }
      const reason: never = failure.reason;
      return reason;
    }
  }
  const state: never = status.state;
  return state;
}

/** The single next step for the current runtime condition. */
export function sshRuntimeRecoveryText(status: SshHostStatus) {
  switch (status.state) {
    case "failed":
      return status.failure?.reason === "archive_unavailable"
        ? "This build has no published server archive. Install a published GOAT release, or set a release mirror."
        : null;
    case "stopped":
      return "GOAT starts it the next time you connect.";
    case "preparing":
      return "The first setup can take a few minutes.";
    case "update_waiting":
      return status.waitingReason === "unknown"
        ? `GOAT can't tell whether ${status.host} is busy. It retries every 10 minutes.`
        : status.waitingReason === "contended"
          ? `Another computer is updating ${status.host}. GOAT will retry.`
          : null;
    case "untrusted":
      return "Approve the host fingerprint before connecting.";
    case "trust_pending":
      return "Open the host approval card.";
    case "auth_failed":
      return "Register your public SSH key on the host, then try again.";
    case "providers_not_ready":
      return status.providers?.fixes[0]?.instruction ?? null;
    case "ready":
    case "update_blocked":
      return null;
  }
}

/** Read and update the Desktop owner's cache; this never resolves a server alias. */
export function createSshRuntimeState<R, E>(
  runtime: Atom.AtomRuntime<R, E>,
  gateway: SshRuntimeOwnerGateway,
) {
  const atoms = Atom.family((_key: string) =>
    Atom.make<SshHostResult | null>(null).pipe(Atom.keepAlive),
  );
  const generations = new WeakMap<AtomRegistry.AtomRegistry, Map<string, number>>();
  const revisions = new WeakMap<AtomRegistry.AtomRegistry, Map<string, number>>();
  const revisionsFor = (registry: AtomRegistry.AtomRegistry) => {
    let values = revisions.get(registry);
    if (!values) {
      values = new Map<string, number>();
      revisions.set(registry, values);
    }
    return values;
  };
  const generationsFor = (registry: AtomRegistry.AtomRegistry) => {
    let values = generations.get(registry);
    if (!values) {
      values = new Map<string, number>();
      generations.set(registry, values);
    }
    return values;
  };
  const invalidate = (registry: AtomRegistry.AtomRegistry, input: SshRuntimeTarget) => {
    const key = sshRuntimeTargetKey(input);
    const values = generationsFor(registry);
    values.set(key, (values.get(key) ?? 0) + 1);
  };
  const command = createRuntimeCommand(runtime, {
    label: "sshRuntime.owner",
    // Mutations serialize per route; cache reads must see phases during a long update.
    concurrency: {
      mode: "serial",
      key: (input: SshRuntimeCommandInput) =>
        `${input.mode === undefined ? "status" : "update"}:${sshRuntimeTargetKey(input)}`,
    },
    execute: (input: SshRuntimeCommandInput, registry) =>
      Effect.gen(function* () {
        const key = sshRuntimeTargetKey(input);
        const current = () => (generationsFor(registry).get(key) ?? 0) === input.generation;
        if (!current()) return null;
        const versions = revisionsFor(registry);
        if (input.mode !== undefined) versions.set(key, (versions.get(key) ?? 0) + 1);
        const revision = versions.get(key) ?? 0;
        const result = yield* input.mode === undefined
          ? gateway.status(input.target)
          : gateway.update(input.target, input.mode);
        if (current()) {
          if (input.mode !== undefined) versions.set(key, (versions.get(key) ?? 0) + 1);
          // A read begun before an update finished cannot replace the update's result.
          if (input.mode !== undefined || (versions.get(key) ?? 0) === revision) {
            registry.set(atoms(key), { ...result });
          }
        }
        return result;
      }),
  });
  const run = (
    registry: AtomRegistry.AtomRegistry,
    input: SshRuntimeTarget & { readonly mode?: SshRuntimeUpdateMode },
  ) =>
    command.run(registry, {
      ...input,
      generation: generationsFor(registry).get(sshRuntimeTargetKey(input)) ?? 0,
    });
  return {
    statusAtom: (input: SshRuntimeTarget) => atoms(sshRuntimeTargetKey(input)),
    refresh: {
      label: "sshRuntime.refresh",
      run: (registry: AtomRegistry.AtomRegistry, input: SshRuntimeTarget) => run(registry, input),
    },
    update: {
      label: "sshRuntime.update",
      run: (
        registry: AtomRegistry.AtomRegistry,
        input: SshRuntimeTarget & { readonly mode: SshRuntimeUpdateMode },
      ) => run(registry, input),
    },
    invalidate,
    forget: (registry: AtomRegistry.AtomRegistry, input: SshRuntimeTarget) => {
      invalidate(registry, input);
      registry.set(atoms(sshRuntimeTargetKey(input)), null);
    },
  };
}
