import { describe, expect, it } from "vite-plus/test";

import { fleetUncountedMachines } from "./fleetCount";
import { fleetHeatDemo } from "./fleetHeatDemo";

describe("fleetUncountedMachines", () => {
  it("leaves out every graph machine that is not an answering server, saying why", () => {
    const { snapshot, connections } = fleetHeatDemo();
    const uncounted = fleetUncountedMachines(snapshot.machines, connections);
    expect(uncounted.map((host) => [host.label, host.reason])).toEqual([
      ["clisu-oracle", "Unreachable"],
      ["nightly-ci", "Boat · Stopped · via mac-studio"],
      ["gpu-box", "SSH host · via mac-studio"],
    ]);
    // The status line's count and its +N cover the graph exactly once.
    expect(snapshot.totals.machines + uncounted.length).toBe(snapshot.machines.length);
  });
});
