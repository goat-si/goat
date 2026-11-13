import { useAtomValue } from "@effect/atom-react";
import type { FleetMachine } from "@goat/client-runtime/state/fleet";
import { hubLinkOfMachine } from "@goat/client-runtime/state/hub-link-traffic";

import { fleetHubAtom } from "~/state/fleetHub";

import { HubDeviceLinkLines } from "../settings/HubLinkLines";

/** The selected Fleet machine's OpenCodex link, when it is a Remote Link Child of the hub. */
export function FleetMachineLink({ machine }: { readonly machine: FleetMachine }) {
  const hub = useAtomValue(fleetHubAtom);
  const device = hub === null ? null : hubLinkOfMachine(hub.devices, machine);
  return device === null ? null : (
    <div data-fleet-machine-link className="flex flex-col gap-0.5">
      <HubDeviceLinkLines device={device} />
    </div>
  );
}
