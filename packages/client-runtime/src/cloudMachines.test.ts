import type { CloudMachine } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  BOAT_MACHINE_STATUS_LABEL,
  boatMachineStatus,
  identifyBoatMachine,
} from "./cloudMachines.ts";

type Record = Pick<CloudMachine, "provider" | "deletePending" | "presence" | "state">;
const record = (overrides: Partial<Record> = {}): Record => ({
  provider: "boat",
  deletePending: false,
  presence: "present",
  state: "running",
  ...overrides,
});

describe("boatMachineStatus", () => {
  it("collapses Boat's lifecycle into what a user can act on", () => {
    const states = [
      ["ready", "running"],
      ["idle", "running"],
      ["running", "running"],
      ["init", "starting"],
      ["provisioning", "starting"],
      ["provisioned", "starting"],
      ["cloning", "starting"],
      ["archiving", "stopping"],
      ["archived", "stopped"],
      ["error", "failed"],
      ["cancelled", "cancelled"],
    ] as const;
    for (const [state, status] of states) {
      expect(boatMachineStatus(record({ state })), state).toBe(status);
    }
  });

  it("lets a pending delete and Boat's own answer outrank the last state", () => {
    expect(boatMachineStatus(record({ deletePending: true, presence: "not_found" }))).toBe(
      "deleting",
    );
    expect(boatMachineStatus(record({ presence: "not_found" }))).toBe("gone");
    expect(boatMachineStatus(record({ presence: "unknown" }))).toBe("unknown");
    expect(boatMachineStatus(record({ state: null }))).toBe("unknown");
  });

  it("keeps the words Settings has always shown", () => {
    expect(BOAT_MACHINE_STATUS_LABEL[boatMachineStatus(record({ state: "archived" }))]).toBe(
      "Stopped",
    );
    expect(BOAT_MACHINE_STATUS_LABEL[boatMachineStatus(record({ state: "cloning" }))]).toBe(
      "Starting",
    );
  });
});

describe("identifyBoatMachine", () => {
  it("trusts the record over any alias", () => {
    expect(
      identifyBoatMachine({ record: record({ state: "archived" }), aliases: ["devbox"] }),
    ).toEqual({
      status: "stopped",
      source: "record",
    });
  });

  it("falls back to the reserved alias prefix, in any case, with the state unknown", () => {
    expect(identifyBoatMachine({ record: null, aliases: ["devbox", "Boat-bx_23456789"] })).toEqual({
      status: "unknown",
      source: "alias",
    });
    expect(identifyBoatMachine({ record: null, aliases: ["boatyard", "my-boat-box"] })).toBeNull();
    expect(identifyBoatMachine({ record: null, aliases: [] })).toBeNull();
  });
});
