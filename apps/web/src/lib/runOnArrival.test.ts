import { EnvironmentId } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import { machineArrivalLabel, resolveMachineArrival } from "./runOnArrival";

const destination = { connectionId: "saved", environmentId: EnvironmentId.make("studio") };
const base = {
  connected: true,
  canClone: true,
  remoteUrl: "git@github.com:goat-si/direction-board.git",
  destinationPath: "~/code/direction-board",
  sshDestination: null,
  sshBlockedReason: null,
};

describe("resolveMachineArrival", () => {
  it("clones from the git remote when the machine can clone, even with an SSH host", () => {
    const arrival = resolveMachineArrival({ ...base, sshDestination: destination });
    expect(arrival).toEqual({
      kind: "clone",
      remoteUrl: base.remoteUrl,
      destinationPath: "~/code/direction-board",
    });
    expect(machineArrivalLabel(arrival)).toBe("Clone to ~/code/direction-board");
  });

  it("copies over SSH when there is no remote and the machine has a usable SSH host", () => {
    const arrival = resolveMachineArrival({
      ...base,
      remoteUrl: null,
      sshDestination: destination,
    });
    expect(arrival).toEqual({ kind: "ssh", destination });
    expect(machineArrivalLabel(arrival)).toBe("Copy over SSH");
  });

  it("copies over SSH when the machine cannot clone but has a usable SSH host", () => {
    expect(
      resolveMachineArrival({ ...base, canClone: false, sshDestination: destination }).kind,
    ).toBe("ssh");
    expect(
      resolveMachineArrival({ ...base, connected: false, sshDestination: destination }).kind,
    ).toBe("ssh");
  });

  it("explains why a machine cannot take the project instead of a dead end", () => {
    expect(resolveMachineArrival({ ...base, connected: false })).toEqual({
      kind: "unavailable",
      reason: "Not connected",
    });
    expect(resolveMachineArrival({ ...base, remoteUrl: null })).toEqual({
      kind: "unavailable",
      reason: "No git remote to clone from",
    });
    expect(resolveMachineArrival({ ...base, canClone: false })).toEqual({
      kind: "unavailable",
      reason: "Can't add projects on this machine",
    });
    expect(
      resolveMachineArrival({
        ...base,
        remoteUrl: null,
        sshDestination: destination,
        sshBlockedReason: "SSH worktrees are available in the desktop app.",
      }),
    ).toEqual({ kind: "unavailable", reason: "SSH worktrees are available in the desktop app." });
  });
});
