import { describe, expect, it } from "vite-plus/test";

import {
  fleetConnectionLegend,
  fleetConnectionVisual,
  presentFleetConnection,
  presentFleetMachineConnection,
  type FleetConnectionInput,
  type FleetConnectionState,
} from "./fleetConnection";

const connection = (
  phase: FleetConnectionInput["phase"],
  extra: Partial<FleetConnectionInput> = {},
): FleetConnectionInput => ({ phase, error: null, ...extra });

const TAILSCALE =
  "Tailscale is not running on this machine. Start Tailscale, then reconnect. (Connection closed by UNKNOWN port 65535)";
const HOST_KEY =
  "SSH could not verify this host's key. Forget the host and add it again to review its fingerprint.";
const ASLEEP = "Cannot reach mbp over SSH (192.168.1.20:22: Operation timed out)";

describe("presentFleetConnection", () => {
  it.each([
    [connection("connected"), "connected", "Connected", null],
    [connection("connecting"), "connecting", "Connecting", null],
    [connection("reconnecting"), "reconnecting", "Reconnecting", null],
    // The host answered but failed, such as a server that cannot start or a slow link.
    [
      connection("reconnecting", { error: "Could not prepare the SSH environment: exit 1" }),
      "degraded",
      "Degraded",
      "Could not prepare the SSH environment: exit 1",
    ],
    // An SSH host asleep or off the network, classified host-unreachable.
    [
      connection("reconnecting", { error: ASLEEP, unreachable: true }),
      "unreachable",
      "Unreachable",
      ASLEEP,
    ],
    [connection("reconnecting", { unreachable: true }), "unreachable", "Unreachable", null],
    [connection("offline"), "offline", "Offline", null],
    [connection("available"), "offline", "Not connected", null],
    // Blocked: a local proxy, host key, or login problem only a person can fix.
    [connection("error", { error: TAILSCALE }), "attention", "Needs attention", TAILSCALE],
    [connection("error", { error: HOST_KEY }), "attention", "Needs attention", HOST_KEY],
    [connection("error"), "attention", "Needs attention", null],
    [connection("unsupported"), "attention", "Client not supported", null],
  ] as const)("%o is %s", (input, state, label, reason) => {
    expect(presentFleetConnection(input)).toEqual({ state, label, reason });
  });

  it("falls back to unknown without a connection or for a phase it does not know", () => {
    expect(presentFleetConnection(null).state).toBe("unknown");
    expect(
      presentFleetConnection({ phase: "paused" } as unknown as FleetConnectionInput).state,
    ).toBe("unknown");
  });

  it("drops an empty reason", () => {
    expect(presentFleetConnection(connection("error", { error: "" })).reason).toBeNull();
  });
});

describe("fleetConnectionVisual", () => {
  const groups: ReadonlyArray<ReadonlyArray<FleetConnectionState>> = [
    ["connected"],
    ["connecting", "reconnecting"],
    ["degraded"],
    ["unreachable", "offline"],
    ["attention"],
  ];

  it("gives each state group its own shape and edge, so color is never the only cue", () => {
    const cues = groups.map((group) => {
      const visuals = group.map(fleetConnectionVisual);
      for (const visual of visuals) expect(visual).toEqual(visuals[0]);
      const visual = visuals[0]!;
      expect(visual.glyph).not.toBeNull();
      return visual.glyph + "|" + (visual.edge?.dash ?? "solid");
    });
    expect(new Set(cues).size).toBe(groups.length);
    expect(new Set(groups.map((group) => fleetConnectionVisual(group[0]!).glyph)).size).toBe(
      groups.length,
    );
  });

  it("animates only an attempt in progress, and shows away hosts quietly", () => {
    const animated = groups.flat().filter((state) => fleetConnectionVisual(state).edge?.animated);
    expect(animated).toEqual(["connecting", "reconnecting"]);
    const quiet = groups.flat().filter((state) => fleetConnectionVisual(state).quiet);
    expect(quiet).toEqual(["unreachable", "offline"]);
  });

  it("keeps the usual node and edge for an unknown or unexpected state", () => {
    const unknown = { glyph: null, tone: "muted", edge: null, quiet: false };
    expect(fleetConnectionVisual("unknown")).toEqual(unknown);
    expect(fleetConnectionVisual("paused" as FleetConnectionState)).toEqual(unknown);
  });
});

describe("fleetConnectionLegend", () => {
  it("lists each shown shape once, healthy first, and leaves unknown out", () => {
    const legend = fleetConnectionLegend(
      [
        connection("error", { error: TAILSCALE }),
        connection("reconnecting", { unreachable: true }),
        connection("connected"),
        connection("connected"),
        connection("available"),
        connection("offline"),
        connection("connecting"),
        connection("reconnecting"),
        null,
      ].map(presentFleetConnection),
    );
    expect(legend.map((entry) => entry.label)).toEqual([
      "Connected",
      "Reconnecting",
      "Not connected",
      "Needs attention",
    ]);
  });
});

describe("presentFleetMachineConnection", () => {
  const away = presentFleetConnection(
    connection("reconnecting", { unreachable: true, error: ASLEEP }),
  );
  const up = presentFleetConnection(connection("connected"));

  it("shows a stopped Boat machine as stopped, apart from a host that is away", () => {
    const stopped = presentFleetMachineConnection({ status: "stopped", source: "record" }, away);
    expect(stopped).toMatchObject({ state: "stopped", label: "Stopped" });
    expect(stopped.reason).toContain("Resume it");
    expect(fleetConnectionVisual(stopped.state).glyph).toBe("square");
    expect(fleetConnectionVisual(away.state).glyph).toBe("ring");
    // Both stay quiet: neither is something to fix right now.
    expect(fleetConnectionVisual(stopped.state).quiet).toBe(true);
    expect(fleetConnectionLegend([stopped, away, up]).map((entry) => entry.label)).toEqual([
      "Connected",
      "Not connected",
      "Stopped",
    ]);
  });

  it("names Boat's transitions and failures even without a connection", () => {
    const present = (status: Parameters<typeof presentFleetMachineConnection>[0]) =>
      presentFleetMachineConnection(status, null);
    expect(present({ status: "starting", source: "record" })).toMatchObject({
      state: "connecting",
      label: "Starting",
    });
    expect(present({ status: "stopping", source: "record" })).toMatchObject({
      state: "connecting",
      label: "Stopping",
    });
    expect(present({ status: "failed", source: "record" })).toMatchObject({
      state: "attention",
      label: "Failed",
    });
  });

  it("lets the connection decide while Boat says running or its state is unknown", () => {
    expect(presentFleetMachineConnection({ status: "running", source: "record" }, away)).toBe(away);
    expect(presentFleetMachineConnection({ status: "unknown", source: "alias" }, up)).toBe(up);
    expect(presentFleetMachineConnection(null, away)).toBe(away);
    expect(presentFleetMachineConnection(null, null).state).toBe("unknown");
  });
});
