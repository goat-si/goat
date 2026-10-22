import type { BoatMachineIdentity } from "@goat/client-runtime/cloud-machines";
import type { EnvironmentConnectionPresentation } from "@goat/client-runtime/connection";

/**
 * What the Fleet graph shows about a machine's connection from this client.
 * It reads the same presentation as Settings > Connections, so the SSH
 * classification (unreachable host, blocked login, host key, proxy) arrives
 * already decided: an unreachable host is `reconnecting` with `unreachable`,
 * and a failure only a person can fix is `error` with the fix in `error`.
 */
export type FleetConnectionState =
  | "connected"
  | "connecting"
  | "reconnecting"
  | "degraded"
  | "unreachable"
  | "offline"
  /** A Boat machine that is not running, so it cannot answer by design. */
  | "stopped"
  | "attention"
  /** Hosts this client has no connection to, such as an SSH host a dispatcher reported. */
  | "unknown";

export type FleetConnectionInput = Pick<
  EnvironmentConnectionPresentation,
  "phase" | "error" | "unreachable"
>;

export interface FleetConnection {
  readonly state: FleetConnectionState;
  /** The state's name, in the words Settings > Connections uses. */
  readonly label: string;
  /** The classified failure, when there is one. */
  readonly reason: string | null;
  /** The step an attempt in progress has reached, such as "Opening connection". */
  readonly step?: string | null;
  /** When this client first saw the connection in this state (epoch ms), for elapsed time. */
  readonly since?: number;
}

export const UNKNOWN_FLEET_CONNECTION: FleetConnection = Object.freeze({
  state: "unknown",
  label: "Status unknown",
  reason: null,
});

export function presentFleetConnection(connection: FleetConnectionInput | null): FleetConnection {
  if (connection === null) return UNKNOWN_FLEET_CONNECTION;
  const reason = connection.error || null;
  switch (connection.phase) {
    case "connected":
      return { state: "connected", label: "Connected", reason: null };
    case "connecting":
      return { state: "connecting", label: "Connecting", reason };
    case "reconnecting":
      // A host that is away (asleep, off the network) is expected, not broken.
      if (connection.unreachable) return { state: "unreachable", label: "Unreachable", reason };
      // The host answered but the attempt failed; it keeps retrying.
      if (reason !== null) return { state: "degraded", label: "Degraded", reason };
      return { state: "reconnecting", label: "Reconnecting", reason: null };
    case "error":
      return { state: "attention", label: "Needs attention", reason };
    case "unsupported":
      return { state: "attention", label: "Client not supported", reason };
    case "offline":
      return { state: "offline", label: "Offline", reason: null };
    case "available":
      return { state: "offline", label: "Not connected", reason: null };
    default:
      return UNKNOWN_FLEET_CONNECTION;
  }
}

const RESUME_HINT = "Resume it in Settings → Connections → Cloud machines.";

/**
 * A machine's state as the graph shows it. For a Boat machine, what Boat says outranks the SSH
 * connection: a stopped machine reads as stopped, not as a host that went away. While Boat says
 * it is running, or its state is unknown, the connection decides.
 */
export function presentFleetMachineConnection(
  boat: BoatMachineIdentity | null,
  connection: FleetConnection | null,
): FleetConnection {
  const live = connection ?? UNKNOWN_FLEET_CONNECTION;
  switch (boat?.status) {
    case "stopped":
      return { state: "stopped", label: "Stopped", reason: RESUME_HINT };
    case "cancelled":
      return { state: "stopped", label: "Cancelled", reason: null };
    case "gone":
      return { state: "stopped", label: "Removed from Boat", reason: null };
    case "starting":
      return { state: "connecting", label: "Starting", reason: null };
    case "stopping":
      return { state: "connecting", label: "Stopping", reason: null };
    case "deleting":
      return { state: "connecting", label: "Deleting", reason: null };
    case "failed":
      return { state: "attention", label: "Failed", reason: null };
    default:
      return live;
  }
}

export type FleetConnectionTone = "success" | "warning" | "destructive" | "muted";

/** In flight: the states that show elapsed time and turn slow after a while. */
export const isFleetConnectionWait = (state: FleetConnectionState) =>
  state === "connecting" || state === "reconnecting";

/** A shape that tells states apart without color. */
export type FleetConnectionShape = "dot" | "arc" | "half" | "ring" | "square" | "alert";

export interface FleetConnectionVisual {
  /** Null leaves the node without a status mark. */
  readonly glyph: FleetConnectionShape | null;
  /** The semantic color token the glyph is drawn in. */
  readonly tone: FleetConnectionTone;
  /** Null keeps the edge's usual look, which follows the machine's work. */
  readonly edge: {
    readonly className: string;
    readonly dash: string | undefined;
    /** Marching dashes, only where motion is allowed. */
    readonly animated: boolean;
  } | null;
  /** Draws the node muted, as Connections does for hosts that are away. */
  readonly quiet: boolean;
}

const VISUALS: Record<FleetConnectionState, FleetConnectionVisual> = {
  connected: {
    glyph: "dot",
    tone: "success",
    edge: null,
    quiet: false,
  },
  connecting: {
    glyph: "arc",
    tone: "warning",
    edge: { className: "stroke-warning/60", dash: "4 4", animated: true },
    quiet: false,
  },
  reconnecting: {
    glyph: "arc",
    tone: "warning",
    edge: { className: "stroke-warning/60", dash: "4 4", animated: true },
    quiet: false,
  },
  degraded: {
    glyph: "half",
    tone: "warning",
    edge: { className: "stroke-warning/60", dash: "8 3", animated: false },
    quiet: false,
  },
  unreachable: {
    glyph: "ring",
    tone: "muted",
    edge: { className: "stroke-border", dash: "1 5", animated: false },
    quiet: true,
  },
  offline: {
    glyph: "ring",
    tone: "muted",
    edge: { className: "stroke-border", dash: "1 5", animated: false },
    quiet: true,
  },
  stopped: {
    glyph: "square",
    tone: "muted",
    edge: { className: "stroke-border", dash: "1 5", animated: false },
    quiet: true,
  },
  attention: {
    glyph: "alert",
    tone: "destructive",
    edge: { className: "stroke-destructive/50", dash: "3 5", animated: false },
    quiet: false,
  },
  unknown: { glyph: null, tone: "muted", edge: null, quiet: false },
};

export function fleetConnectionVisual(state: FleetConnectionState): FleetConnectionVisual {
  return VISUALS[state] ?? VISUALS.unknown;
}

/** One legend entry per shape, in the order healthy, in flight, away, blocked. */
const LEGEND: ReadonlyArray<{ readonly state: FleetConnectionState; readonly label: string }> = [
  { state: "connected", label: "Connected" },
  { state: "reconnecting", label: "Reconnecting" },
  { state: "degraded", label: "Degraded" },
  // Unreachable, offline and switched-off-but-saved hosts share the quiet mark;
  // each node's tooltip names which.
  { state: "unreachable", label: "Not connected" },
  { state: "stopped", label: "Stopped" },
  { state: "attention", label: "Needs attention" },
];

/** The legend entries for the shapes the graph shows right now. */
export function fleetConnectionLegend(
  connections: Iterable<FleetConnection>,
): ReadonlyArray<{ readonly state: FleetConnectionState; readonly label: string }> {
  const shown = new Set<FleetConnectionShape>();
  for (const connection of connections) {
    const { glyph } = fleetConnectionVisual(connection.state);
    if (glyph !== null) shown.add(glyph);
  }
  return LEGEND.filter((entry) => shown.has(fleetConnectionVisual(entry.state).glyph!));
}
