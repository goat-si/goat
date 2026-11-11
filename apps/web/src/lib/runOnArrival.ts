import type { DraftSshDestination } from "../composerDraftStore";
import type { EnvironmentOption } from "../components/BranchToolbar.logic";
import type { SavedSshWorktreeOption } from "./sshWorktree";

/** How a project gets onto a machine that does not have it yet, picked from Run on. */
export type MachineArrival =
  | { readonly kind: "clone"; readonly remoteUrl: string; readonly destinationPath: string }
  | { readonly kind: "ssh"; readonly destination: DraftSshDestination }
  | { readonly kind: "unavailable"; readonly reason: string };

export interface MachineWithoutProject extends EnvironmentOption {
  readonly arrival: MachineArrival;
}

/** A machine without the project, before saved SSH hosts are matched to it. */
export interface MachineCandidate extends EnvironmentOption {
  readonly connected: boolean;
  readonly canClone: boolean;
  readonly remoteUrl: string | null;
  readonly destinationPath: string;
}

/** `sshBlockedReason` is why this draft cannot pick any SSH host right now. */
export function resolveMachineArrivals(
  machines: readonly MachineCandidate[],
  sshOptions: ReadonlyArray<SavedSshWorktreeOption>,
  sshBlockedReason: string | null,
): readonly MachineWithoutProject[] {
  return machines.map(({ connected, canClone, remoteUrl, destinationPath, ...machine }) => {
    const sshOption =
      sshOptions.find((option) => option.destination.environmentId === machine.environmentId) ??
      null;
    return {
      ...machine,
      arrival: resolveMachineArrival({
        connected,
        canClone,
        remoteUrl,
        destinationPath,
        sshDestination: sshOption?.destination ?? null,
        sshBlockedReason: sshBlockedReason ?? sshOption?.disabledReason ?? null,
      }),
    };
  });
}

/**
 * The project's git remote comes first, since a clone leaves a normal project on that
 * machine. Without one, a saved SSH host for that machine copies this device's checkout.
 */
export function resolveMachineArrival(input: {
  readonly connected: boolean;
  readonly canClone: boolean;
  readonly remoteUrl: string | null;
  readonly destinationPath: string;
  readonly sshDestination: DraftSshDestination | null;
  readonly sshBlockedReason: string | null;
}): MachineArrival {
  if (input.connected && input.remoteUrl && input.canClone) {
    return { kind: "clone", remoteUrl: input.remoteUrl, destinationPath: input.destinationPath };
  }
  // SSH reaches the host itself, so it does not need this machine's GOAT connected.
  if (input.sshDestination) {
    return input.sshBlockedReason
      ? { kind: "unavailable", reason: input.sshBlockedReason }
      : { kind: "ssh", destination: input.sshDestination };
  }
  if (!input.connected) return { kind: "unavailable", reason: "Not connected" };
  return {
    kind: "unavailable",
    reason: input.remoteUrl ? "Can't add projects on this machine" : "No git remote to clone from",
  };
}

export function machineArrivalLabel(arrival: MachineArrival): string {
  switch (arrival.kind) {
    case "clone":
      return `Clone to ${arrival.destinationPath}`;
    case "ssh":
      return "Copy over SSH";
    case "unavailable":
      return arrival.reason;
  }
}
