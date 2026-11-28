// Seam for v1 packages/client-runtime/src/connection (goat 916b5ccc1b2). v1's connection catalog (SSH, relay, hub
// proxy routes, credential profiles) is not carried: GOAT 2 has one local host, which v1 calls the primary target,
// with no profile and no extra routes. Type shapes follow v1 model.ts/catalog.ts; connectionStatusTitle keeps v1's
// phase wording (presentation.ts:17-24).
import type { DesktopSshEnvironmentTarget } from "@goat/contracts";
import type * as Option from "effect/Option";

export type EnvironmentConnectionPhase =
  | "available"
  | "offline"
  | "connecting"
  | "reconnecting"
  | "connected"
  | "error"
  | "unsupported";

export interface EnvironmentConnectionPresentation {
  readonly phase: EnvironmentConnectionPhase;
  readonly error: string | null;
  readonly traceId: string | null;
  readonly unreachable?: boolean;
}

export type ConnectionTarget =
  | { readonly _tag: "PrimaryConnectionTarget"; readonly label: string }
  | { readonly _tag: "RelayConnectionTarget"; readonly label: string }
  | { readonly _tag: "SshConnectionTarget"; readonly label: string; readonly connectionId: string }
  | { readonly _tag: "HubProxyConnectionTarget"; readonly label: string };

export type ConnectionProfile =
  | { readonly _tag: "BearerConnectionProfile"; readonly authorization: string }
  | { readonly _tag: "SshConnectionProfile"; readonly target: DesktopSshEnvironmentTarget };

export interface ConnectionRoute {
  readonly target: ConnectionTarget;
  readonly profile: Option.Option<ConnectionProfile>;
  readonly enabled: boolean;
}

export interface ConnectionCatalogEntry {
  readonly target: ConnectionTarget;
  readonly profile: Option.Option<ConnectionProfile>;
  readonly enabled: boolean;
}

const PHASE_TEXT: Record<EnvironmentConnectionPhase, string> = {
  available: "Available",
  offline: "Offline",
  connecting: "Connecting...",
  reconnecting: "Reconnecting...",
  connected: "Connected",
  error: "Failed to connect",
  unsupported: "Unsupported",
};

export function connectionStatusTitle(connection: EnvironmentConnectionPresentation): string {
  return connection.phase === "error" && connection.error ? connection.error : PHASE_TEXT[connection.phase];
}

/** The primary target has no alternate routes in GOAT 2. */
export function connectionRoutes(_entry: ConnectionCatalogEntry): ReadonlyArray<ConnectionRoute> {
  return [];
}

export function usableRoutes(_entry: ConnectionCatalogEntry): ReadonlyArray<ConnectionRoute> {
  return [];
}

export function connectionRouteId(target: ConnectionTarget): string {
  return target._tag + ":" + target.label;
}

export function connectionRouteKind(_route: ConnectionRoute): "primary" | "relay" | "ssh" | "hub-proxy" {
  return "primary";
}

export function connectionRouteLabel(route: ConnectionRoute): string {
  return route.target.label;
}

export function penRouteOwner(_connectionId: unknown): string | null {
  return null;
}
