import type {
  FleetConnection,
  FleetConnectionState,
} from "@goat/client-runtime/state/fleet-connection";

export {
  isFleetConnectionWait,
  presentFleetConnection,
  presentFleetMachineConnection,
  UNKNOWN_FLEET_CONNECTION,
  type FleetConnection,
  type FleetConnectionState,
} from "@goat/client-runtime/state/fleet-connection";

export type FleetConnectionTone = "success" | "warning" | "destructive" | "muted";

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
