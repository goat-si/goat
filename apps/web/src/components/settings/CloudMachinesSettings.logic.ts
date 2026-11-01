import { BOAT_MACHINE_STATUS_LABEL, boatMachineStatus } from "@goat/client-runtime/cloud-machines";
import type { CloudMachine, CloudMachineType } from "@goat/contracts";

/** What a user may do with a machine in its current state. Every server call rechecks. */
export interface CloudMachineActions {
  /** Resume if needed, then open it over SSH (desktop only). */
  readonly connect: boolean;
  readonly stop: boolean;
  readonly resume: boolean;
  readonly delete: boolean;
  /** Drop it from this list without touching Boat; only once stopped or gone. */
  readonly forget: boolean;
}

const NONE: CloudMachineActions = {
  connect: false,
  stop: false,
  resume: false,
  delete: false,
  forget: false,
};

export function cloudMachineActions(machine: CloudMachine): CloudMachineActions {
  if (machine.deletePending) return NONE;
  if (machine.presence === "not_found") return { ...NONE, forget: true };
  if (machine.presence === "unknown" || machine.state === null) return NONE;
  switch (machine.state) {
    case "ready":
    case "idle":
    case "running":
      return { ...NONE, connect: true, stop: true, delete: true };
    case "archived":
      return { ...NONE, connect: true, resume: true, delete: true, forget: true };
    case "init":
    case "provisioning":
    case "provisioned":
    case "cloning":
      return { ...NONE, connect: true, delete: true };
    case "archiving":
      return NONE;
    case "error":
    case "cancelled":
      return { ...NONE, delete: true };
  }
}

export function cloudMachineStatus(machine: CloudMachine): string {
  return BOAT_MACHINE_STATUS_LABEL[boatMachineStatus(machine)];
}

export function formatAutoStop(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400} d`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600} h`;
  return `${Math.round(seconds / 60)} min`;
}

export const CLOUD_MACHINE_SIZES: ReadonlyArray<{
  readonly value: CloudMachineType;
  readonly label: string;
}> = [
  { value: "small", label: "Small (half rate)" },
  { value: "default", label: "Default" },
  { value: "large", label: "Large (double rate)" },
  { value: "xlarge", label: "Extra large" },
];

export const CLOUD_MACHINE_AUTO_STOP_SECONDS = [1_800, 3_600, 14_400, 86_400, 604_800] as const;
