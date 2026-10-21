import type { FleetMachine } from "@goat/client-runtime/state/fleet";

import { fleetMachineSubtitle } from "./describeMachine";
import type { FleetConnection } from "./fleetConnection";
import type { FleetHostRow } from "./fleetTelemetry";

/** A host the graph or console shows that the machine count leaves out, with why. */
export interface FleetUncountedHost {
  readonly key: string;
  readonly label: string;
  readonly reason: string;
}

type CountedMachine = Pick<
  FleetMachine,
  "id" | "label" | "answering" | "environmentId" | "boat" | "os" | "machineKind" | "subtitle"
>;

function uncountedReason(machine: CountedMachine, connection: FleetConnection | undefined): string {
  // A saved server: its connection says why it does not answer, as its node's tooltip does.
  if (machine.environmentId !== null) {
    const state = connection?.label ?? "Not connected";
    return machine.boat === null ? state : "Boat · " + state;
  }
  if (machine.boat !== null) return fleetMachineSubtitle(machine) ?? "Boat";
  return machine.subtitle === null ? "SSH host" : "SSH host · " + machine.subtitle;
}

/** The graph's machines the count leaves out, in graph order. */
export function fleetUncountedMachines(
  machines: ReadonlyArray<CountedMachine>,
  connections: ReadonlyMap<string, FleetConnection>,
): ReadonlyArray<FleetUncountedHost> {
  return machines.flatMap((machine) =>
    machine.answering
      ? []
      : [
          {
            key: machine.id,
            label: machine.label,
            reason: uncountedReason(machine, connections.get(machine.id)),
          },
        ],
  );
}

/**
 * The console's Hosts header: answering servers reporting metrics, out of the answering
 * servers the page counts, plus the rows listed beside them that are not counted.
 */
export function fleetHostCount(input: {
  readonly rows: ReadonlyArray<Pick<FleetHostRow, "key" | "label" | "machineId" | "tone">>;
  readonly machines: ReadonlyArray<CountedMachine>;
  readonly connections: ReadonlyMap<string, FleetConnection>;
}): {
  readonly reporting: number;
  readonly uncounted: ReadonlyArray<FleetUncountedHost>;
} {
  const machineById = new Map(input.machines.map((machine) => [machine.id, machine]));
  let reporting = 0;
  const uncounted: FleetUncountedHost[] = [];
  for (const row of input.rows) {
    const machine = row.machineId === null ? undefined : machineById.get(row.machineId);
    if (machine?.answering === true) {
      if (row.tone === "ok") reporting += 1;
    } else if (machine !== undefined) {
      uncounted.push({
        key: row.key,
        label: row.label,
        reason: uncountedReason(machine, input.connections.get(machine.id)),
      });
    } else {
      // A host a server's status read named that no Fleet machine claims.
      uncounted.push({ key: row.key, label: row.label, reason: "SSH host" });
    }
  }
  return { reporting, uncounted };
}
