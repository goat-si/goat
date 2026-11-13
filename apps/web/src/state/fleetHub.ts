import { hubSnapshot } from "@goat/client-runtime/state/hub-fleet";
import { Atom } from "effect/reactivity";

import { fleetHostReportsAtom } from "./fleetHostMetrics";

/** The hub as Fleet's own host-status reads show it, for the selected machine's link line. */
export const fleetHubAtom = Atom.make((get) =>
  hubSnapshot(
    [...get(fleetHostReportsAtom).reports].flatMap(([environmentId, hosts]) =>
      hosts.map((entry) => ({
        key: `${environmentId}:${entry.host ?? ""}`,
        label: entry.host ?? environmentId,
        entry,
      })),
    ),
  ),
).pipe(Atom.withLabel("fleet-hub"));
