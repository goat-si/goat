import { hasCloudMachineAliasPrefix, type CloudMachine } from "@goat/contracts";

/**
 * What a Boat machine is doing, in the words every client shows. Boat reports more states than a
 * user can tell apart; these are the ones that change what they can do with the machine.
 */
export type BoatMachineStatus =
  | "running"
  | "starting"
  | "stopping"
  | "stopped"
  | "failed"
  | "cancelled"
  | "deleting"
  | "gone"
  | "unknown";

export const BOAT_MACHINE_STATUS_LABEL: Record<BoatMachineStatus, string> = {
  running: "Running",
  starting: "Starting",
  stopping: "Stopping",
  stopped: "Stopped",
  failed: "Failed",
  cancelled: "Cancelled",
  deleting: "Deleting",
  gone: "Boat no longer shows this machine",
  unknown: "State unknown",
};

export function boatMachineStatus(
  machine: Pick<CloudMachine, "deletePending" | "presence" | "state">,
): BoatMachineStatus {
  if (machine.deletePending) return "deleting";
  if (machine.presence === "not_found") return "gone";
  if (machine.presence === "unknown" || machine.state === null) return "unknown";
  switch (machine.state) {
    case "ready":
    case "idle":
    case "running":
      return "running";
    case "archived":
      return "stopped";
    case "archiving":
      return "stopping";
    case "error":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "init":
    case "provisioning":
    case "provisioned":
    case "cloning":
      return "starting";
  }
}

export interface BoatMachineIdentity {
  readonly status: BoatMachineStatus;
  /**
   * "record" when a server's cloud machine list describes it. "alias" when only its reserved SSH
   * alias says it is Boat's, so its state is not known here.
   */
  readonly source: "record" | "alias";
}

/**
 * Whether a host is a Boat machine, and what it is doing. The record a server keeps decides; the
 * reserved alias prefix answers only when no record is at hand, such as a launch reported to a
 * host whose dispatcher's cloud machine list has not loaded.
 */
export function identifyBoatMachine(input: {
  readonly record: Pick<CloudMachine, "provider" | "deletePending" | "presence" | "state"> | null;
  readonly aliases: Iterable<string>;
}): BoatMachineIdentity | null {
  if (input.record !== null) {
    return input.record.provider === "boat"
      ? { status: boatMachineStatus(input.record), source: "record" }
      : null;
  }
  for (const alias of input.aliases) {
    if (hasCloudMachineAliasPrefix(alias)) return { status: "unknown", source: "alias" };
  }
  return null;
}
