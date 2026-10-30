import type { BoatMachineIdentity } from "../cloudMachines.ts";
import type { EnvironmentConnectionPresentation } from "../connection/presentation.ts";

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
/** In flight: the states that show elapsed time and turn slow after a while. */
export const isFleetConnectionWait = (state: FleetConnectionState) =>
  state === "connecting" || state === "reconnecting";
