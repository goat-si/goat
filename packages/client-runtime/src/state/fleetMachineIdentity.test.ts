import { EnvironmentId } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildFleet, fleetSshConfigScopes, summarizeFleet } from "./fleet.ts";
import { env, shell } from "./fleet.testkit.ts";

const mac = EnvironmentId.make("desktop");
const headless = EnvironmentId.make("headless");
const remote = EnvironmentId.make("remote");

describe("Fleet machines cloned from one image", () => {
  it("draws clones of one image as separate machines with their own threads and counts", () => {
    // Every clone reports the image's OS identifier but its own ~/.goat install.
    const clones = (["cc-01", "cc-02", "cc-03"] as const).map((label) => ({
      ...env(EnvironmentId.make(label), label + " (Cursor Cloud)", [label]),
      machineId: "image-machine",
      machineUserId: "image-machine-ubuntu",
      machineInstallId: "install-" + label,
    }));
    const shells = clones.flatMap((clone, index) =>
      Array.from({ length: index + 1 }, (_, n) => shell(clone.environmentId, clone.label + n)),
    );
    const fleet = buildFleet({
      environments: clones,
      primaryEnvironmentId: null,
      shells,
      remote: [],
    });

    expect(fleet.machines.map((machine) => [machine.label, machine.running])).toEqual([
      ["cc-01 (Cursor Cloud)", 1],
      ["cc-02 (Cursor Cloud)", 2],
      ["cc-03 (Cursor Cloud)", 3],
    ]);
    expect(fleet.totals.machines).toBe(3);
    expect(summarizeFleet(shells, clones).machines.map((machine) => machine.running)).toEqual([
      1, 2, 3,
    ]);
    expect(new Set(fleetSshConfigScopes(clones).values()).size).toBe(3);
  });

  it("keeps a machine's servers together while only one of them reports its install", () => {
    // The desktop server updated first; the headless server beside it still runs an older GOAT.
    const mixed = [
      { ...env(mac, "Mac"), machineId: "machine-a", machineUserId: "jun", machineInstallId: "i" },
      { ...env(headless, "Headless"), machineId: "machine-a", machineUserId: "jun" },
    ];
    const fleet = buildFleet({
      environments: mixed,
      primaryEnvironmentId: mac,
      shells: [shell(mac, "a"), shell(headless, "b")],
      remote: [],
    });

    expect(fleet.machines.map((machine) => [machine.label, machine.running])).toEqual([["Mac", 2]]);
    expect(new Set(fleetSshConfigScopes(mixed).values()).size).toBe(1);
  });

  it("leaves a server that predates installs alone when clones beside it disagree", () => {
    const fleet = buildFleet({
      environments: [
        { ...env(mac, "Clone A"), machineId: "image", machineInstallId: "a" },
        { ...env(headless, "Clone B"), machineId: "image", machineInstallId: "b" },
        { ...env(remote, "Old clone"), machineId: "image" },
      ],
      primaryEnvironmentId: null,
      shells: [],
      remote: [],
    });

    expect(fleet.machines.map((machine) => machine.label)).toEqual([
      "Clone A",
      "Clone B",
      "Old clone",
    ]);
  });
});
