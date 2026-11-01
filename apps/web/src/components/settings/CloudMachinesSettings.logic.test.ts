import type { CloudMachine } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  cloudMachineActions,
  cloudMachineStatus,
  formatAutoStop,
} from "./CloudMachinesSettings.logic";

const machine = (overrides: Partial<CloudMachine>): CloudMachine => ({
  alias: "boat-bx_23456789",
  sandboxId: "bx_23456789",
  label: "Build box",
  provider: "boat",
  type: "small",
  ttlSeconds: 3_600,
  presence: "present",
  state: "running",
  deletePending: false,
  lastError: null,
  ...overrides,
});

describe("cloudMachineActions", () => {
  it.each([
    ["running", { state: "running" }, "Running", ["connect", "stop", "delete"]],
    ["stopped", { state: "archived" }, "Stopped", ["connect", "resume", "delete", "forget"]],
    ["stopping", { state: "archiving" }, "Stopping", []],
    ["starting", { state: "provisioning" }, "Starting", ["connect", "delete"]],
    ["failed", { state: "error" }, "Failed", ["delete"]],
    [
      "gone from Boat",
      { presence: "not_found", state: null },
      "Boat no longer shows this machine",
      ["forget"],
    ],
    ["unreachable Boat", { presence: "unknown", state: null }, "State unknown", []],
    ["deleting", { deletePending: true }, "Deleting", []],
  ] as const)("offers the right actions for a %s machine", (_name, overrides, status, allowed) => {
    const subject = machine(overrides);
    expect(cloudMachineStatus(subject)).toBe(status);
    const actions = cloudMachineActions(subject);
    expect(
      Object.entries(actions)
        .filter(([, on]) => on)
        .map(([name]) => name),
    ).toEqual(allowed);
  });
});

describe("formatAutoStop", () => {
  it("uses the largest whole unit", () => {
    expect([1_800, 3_600, 14_400, 86_400, 604_800].map(formatAutoStop)).toEqual([
      "30 min",
      "1 h",
      "4 h",
      "1 d",
      "7 d",
    ]);
  });
});
