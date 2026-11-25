import { englishFleetText, type FleetText } from "./fleetText.ts";
import { BOAT_MACHINE_STATUS_LABEL } from "../cloudMachines.ts";
import type { FleetMachine } from "./fleet.ts";
import type { EnvironmentMachineKind, ExecutionEnvironmentPlatformOs } from "@goat/contracts";

const MAC_MODELS: Partial<Record<EnvironmentMachineKind, string>> = {
  laptop: "MacBook",
  "mac-mini": "Mac mini",
  "mac-studio": "Mac Studio",
  desktop: "iMac",
};

const KIND_NOUNS: Record<EnvironmentMachineKind, string | null> = {
  laptop: "laptop",
  desktop: "desktop",
  server: "server",
  cloud: "cloud VM",
  linux: null,
  "mac-mini": "mini PC",
  "mac-studio": "workstation",
};

const OS_NAMES: Partial<Record<ExecutionEnvironmentPlatformOs, string>> = {
  darwin: "Mac",
  linux: "Linux",
  windows: "Windows",
};

/**
 * Names a host by its OS and hardware shape, such as "MacBook", "Mac Studio", "Linux
 * server" or "Windows laptop". Null when the server has reported neither.
 */
function describeMachine(
  os: ExecutionEnvironmentPlatformOs | null,
  kind: EnvironmentMachineKind | null,
  gt: FleetText,
): string | null {
  if (os === "darwin") return (kind && MAC_MODELS[kind]) ?? "Mac";
  const osName = os === null ? null : (OS_NAMES[os] ?? null);
  const noun = kind === null ? null : KIND_NOUNS[kind];
  if (osName !== null && noun !== null) return gt("{os} {kind}", { os: osName, kind: gt(noun) });
  if (osName !== null) return osName;
  if (kind === "linux") return "Linux";
  return noun === null ? null : gt(noun.charAt(0).toUpperCase() + noun.slice(1));
}

/** "Boat · Stopped · via Mac", "MacBook", or null when nothing is known about the host. */
export function fleetMachineSubtitle(
  machine: Pick<FleetMachine, "os" | "machineKind" | "subtitle" | "boat" | "viaLabel">,
  gt: FleetText = englishFleetText,
): string | null {
  const boat =
    machine.boat === null
      ? null
      : machine.boat.status === "unknown"
        ? "Boat"
        : "Boat · " + gt(BOAT_MACHINE_STATUS_LABEL[machine.boat.status]);
  const parts = [
    boat,
    describeMachine(machine.os, machine.machineKind, gt),
    machine.viaLabel == null ? machine.subtitle : gt("via {host}", { host: machine.viaLabel }),
  ].filter((part) => part !== null);
  return parts.length === 0 ? null : parts.join(" · ");
}

/** "2 running · 1 need you", or "Idle" when nothing runs there. */
export function fleetMachineWork(
  machine: Pick<FleetMachine, "running" | "attention" | "reported">,
  gt: FleetText = englishFleetText,
  separator = " · ",
): string {
  const parts = [
    machine.running > 0 ? gt("{count} running", { count: machine.running }) : null,
    machine.attention > 0 ? gt("{count} need you", { count: machine.attention }) : null,
    machine.reported > 0 ? gt("{count} reported", { count: machine.reported }) : null,
  ].filter((part) => part !== null);
  return parts.length === 0 ? gt("Idle") : parts.join(separator);
}

export const isFleetMachineBusy = (
  machine: Pick<FleetMachine, "running" | "attention" | "reported">,
) => machine.running + machine.attention + machine.reported > 0;

/** What a running Boat machine with nothing on it says: Boat bills it, and who can stop it. */
export const fleetIdleBillingLabel = (ownerLabel: string) =>
  "Billing while idle · stop it from " + ownerLabel;
