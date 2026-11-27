import { expect, it } from "vite-plus/test";
import { fleetMachineSubtitle } from "./fleetMachineDescription.ts";

const machine = {
  os: null,
  machineKind: "laptop",
  subtitle: null,
  boat: null,
  viaLabel: null,
} as const;

it("names a machine of unknown OS by its translated kind", () => {
  const french = (source: string) => (source === "laptop" ? "ordinateur portable" : source);
  expect(fleetMachineSubtitle(machine, french)).toBe("Ordinateur portable");
  expect(fleetMachineSubtitle(machine)).toBe("Laptop");
});
