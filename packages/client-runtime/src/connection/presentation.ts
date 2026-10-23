import type { ServerConfig, SshHostStatus } from "@goat/contracts";
import * as Option from "effect/Option";

import type { ConnectionCatalogEntry } from "./catalog.ts";
import type {
  ConnectionAttemptStage,
  ConnectionFailure,
  ConnectionFailureOrigin,
  ConnectionSshPreparation,
  ConnectionSshRuntimeReady,
  ConnectionTarget,
  SupervisorConnectionState,
} from "./model.ts";
import { sshRuntimePhaseText } from "../state/sshRuntime.ts";
import { connectionRouteId, connectionRoutes, routeHttpBaseUrl } from "./routes.ts";

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
  readonly failureOrigin?: ConnectionFailureOrigin;
  readonly sshPreparation?: ConnectionSshPreparation;
  readonly sshRuntimeReady?: ConnectionSshRuntimeReady;
  readonly failureSuppressed?: true;
  readonly error: string | null;
  readonly traceId: string | null;
  readonly failure?: {
    readonly kind: "blocked" | "retrying";
    readonly reason: ConnectionFailure["reason"];
    readonly detail: string;
    readonly traceId?: string;
  };
  /** The step an attempt in progress has reached. */
  readonly stage?: ConnectionAttemptStage | null;
  /** When the next automatic attempt starts (epoch ms), while waiting to retry. */
  readonly retryAt?: number | null;
  /**
   * Reconnecting because the host could not be reached at all, such as a
   * laptop asleep in a bag. Surfaces show this quietly: it is expected, and
   * retrying on its own is the right response.
   */
  readonly unreachable?: boolean;
}

/**
 * Provider statuses are pushed every few minutes with fresh `checkedAt` stamps, and every root
 * coordinator reads environment presentations. Leaving them out keeps a presentation stable
 * across those pushes; provider readers subscribe to the server's providers atom instead.
 */
export type EnvironmentServerConfig = Omit<ServerConfig, "providers">;

export interface EnvironmentPresentation {
  readonly entry: ConnectionCatalogEntry;
  readonly connection: EnvironmentConnectionPresentation;
  readonly serverConfig: EnvironmentServerConfig | null;
}

function projectConnectionState(
  state: SupervisorConnectionState,
): EnvironmentConnectionPresentation {
  const unreachable = state.lastFailure?.reason === "host-unreachable";
  const failure =
    state.lastFailure === null
      ? {}
      : {
          failure: {
            kind:
              state.lastFailure._tag === "ConnectionBlockedError"
                ? ("blocked" as const)
                : ("retrying" as const),
            reason: state.lastFailure.reason,
            detail: state.lastFailure.detail,
            ...(state.lastFailure.traceId ? { traceId: state.lastFailure.traceId } : {}),
          },
        };
  switch (state.phase) {
    case "available":
      return { phase: "available", error: null, traceId: null };
    case "offline":
      return { phase: "offline", error: null, traceId: null, ...failure };
    case "connecting":
      return {
        phase: state.attempt <= 1 && state.lastFailure === null ? "connecting" : "reconnecting",
        error: state.lastFailure?.message ?? null,
        traceId: state.lastFailure?.traceId ?? null,
        stage: state.stage,
        ...failure,
        ...(unreachable ? { unreachable } : {}),
      };
    case "connected":
      return { phase: "connected", error: null, traceId: null };
    case "backoff":
      return {
        phase: "reconnecting",
        error: state.lastFailure?.message ?? null,
        traceId: state.lastFailure?.traceId ?? null,
        retryAt: state.retryAt,
        ...failure,
        ...(unreachable ? { unreachable } : {}),
      };
    case "blocked":
      return {
        phase: state.lastFailure?.reason === "unsupported" ? "unsupported" : "error",
        error: state.lastFailure?.message ?? null,
        traceId: state.lastFailure?.traceId ?? null,
        ...failure,
      };
  }
}

/** Native ready evidence orders attempts; a status poll never creates that provenance. */
export function reconcileSshConnectionPresentation(
  connection: EnvironmentConnectionPresentation,
  runtimeStatus?: SshHostStatus,
): EnvironmentConnectionPresentation {
  const { failureSuppressed: _suppressed, sshRuntimeReady: observedReady, ...rest } = connection;
  const invalidated =
    runtimeStatus !== undefined &&
    runtimeStatus.state !== "ready" &&
    runtimeStatus.state !== "preparing";
  const base = {
    ...rest,
    ...(!invalidated && observedReady !== undefined ? { sshRuntimeReady: observedReady } : {}),
  };
  const active =
    (base.phase === "connecting" || base.phase === "reconnecting") &&
    base.sshPreparation !== undefined;
  const ready =
    runtimeStatus !== undefined &&
    runtimeStatus.state !== "ready" &&
    runtimeStatus.state !== "preparing"
      ? undefined
      : base.sshRuntimeReady;
  const origin = base.failureOrigin;
  const staleSetupTimeout =
    base.failure?.reason === "timeout" &&
    origin?.setupTimeout === true &&
    ready?.runtimeStatus.state === "ready" &&
    ready.supervisorId === origin.supervisorId &&
    ready.routeId === origin.routeId &&
    ready.attemptId > origin.attemptId;
  if (
    (base.phase === "connecting" || base.phase === "reconnecting") &&
    (active || staleSetupTimeout)
  ) {
    return { ...base, error: null, traceId: null, unreachable: false, failureSuppressed: true };
  }
  if (connection.failureSuppressed) {
    const { sshRuntimeReady: _ready, ...withoutReady } = base;
    return {
      ...withoutReady,
      ...(ready === undefined ? {} : { sshRuntimeReady: ready }),
      error: base.failure?.detail ?? null,
      traceId: base.failure?.traceId ?? null,
      ...(base.failure?.reason === "host-unreachable" ? { unreachable: true } : {}),
    };
  }
  return invalidated && observedReady !== undefined ? base : connection;
}

export function presentConnectionState(
  state: SupervisorConnectionState,
  runtimeStatus?: SshHostStatus,
): EnvironmentConnectionPresentation {
  return reconcileSshConnectionPresentation(
    {
      ...projectConnectionState(state),
      ...(state.failureOrigin === undefined ? {} : { failureOrigin: state.failureOrigin }),
      ...(state.sshPreparation === undefined ? {} : { sshPreparation: state.sshPreparation }),
      ...(state.sshRuntimeReady === undefined ? {} : { sshRuntimeReady: state.sshRuntimeReady }),
    },
    runtimeStatus,
  );
}

function preparationLabel(connection: EnvironmentConnectionPresentation): string | undefined {
  return (connection.phase === "connecting" || connection.phase === "reconnecting") &&
    connection.sshPreparation !== undefined
    ? sshRuntimePhaseText(connection.sshPreparation.phase)
    : undefined;
}

export function connectionStatusText(connection: EnvironmentConnectionPresentation): string {
  connection = reconcileSshConnectionPresentation(connection);
  const phase = preparationLabel(connection);
  if (phase !== undefined) return phase;
  if (connection.failureSuppressed && connection.sshRuntimeReady !== undefined) {
    return `Runtime ready · ${connectionProgressLabel(connection, 0)}`;
  }
  switch (connection.phase) {
    case "available":
      return "Available";
    case "offline":
      return "Offline";
    case "connecting":
      return "Connecting...";
    case "reconnecting":
      if (connection.unreachable) {
        return connection.error
          ? `Host unreachable. Reconnecting... Reason: ${connection.error}`
          : "Host unreachable. Reconnecting...";
      }
      return connection.error
        ? `Failed to connect. Reconnecting... Reason: ${connection.error}`
        : "Reconnecting...";
    case "connected":
      return "Connected";
    case "unsupported":
      return "Client not supported";
    case "error":
      return connection.error
        ? `Connection failed. Reason: ${connection.error}`
        : "Connection failed";
  }
}

export function connectionStatusTitle(connection: EnvironmentConnectionPresentation): string {
  connection = reconcileSshConnectionPresentation(connection);
  const phase = preparationLabel(connection);
  if (phase !== undefined) return phase;
  if (connection.phase === "reconnecting" && connection.unreachable) return "Host unreachable";
  if (connection.phase === "reconnecting" && connection.error) {
    return "Failed to connect. Reconnecting...";
  }
  return connectionStatusText({ ...connection, error: null });
}

/**
 * How old the threads shown for a disconnected environment are, from the capture time stored with
 * that exact snapshot. Null when the age is unknown, so callers show plain status instead of a
 * borrowed time.
 */
export function offlineSnapshotAgeLabel(capturedAt: string | null, nowMs: number): string | null {
  if (capturedAt === null) return null;
  const capturedMs = Date.parse(capturedAt);
  if (!Number.isFinite(capturedMs)) return null;
  const minutes = Math.max(0, Math.floor((nowMs - capturedMs) / 60_000));
  if (minutes < 1) return "last state just now";
  if (minutes < 60) return `last state ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `last state ${hours} h ago`;
  return `last state ${Math.floor(hours / 24)} d ago`;
}

/**
 * Whether a connection row names its snapshot age. While an attempt runs or counts down to its
 * retry, the row shows that live progress, and a cached-threads age beside it reads as if the
 * status were stale.
 */
export function connectionRowShowsSnapshotAge(connection: EnvironmentConnectionPresentation) {
  return (
    connection.phase === "offline" ||
    connection.phase === "error" ||
    connection.phase === "unsupported"
  );
}

/** A retry waiting on its backoff, which opening or refreshing the connection may start now. */
export function connectionWaitsToRetry(connection: EnvironmentConnectionPresentation): boolean {
  return connection.phase === "reconnecting" && connection.retryAt != null;
}

/** An attempt is running now, as opposed to waiting on its backoff or idle. */
export function connectionAttemptRunning(connection: EnvironmentConnectionPresentation): boolean {
  return (
    (connection.phase === "connecting" || connection.phase === "reconnecting") &&
    connection.retryAt == null
  );
}

function formatRetryDelay(seconds: number): string {
  return seconds < 60 ? `${seconds}s` : `${Math.ceil(seconds / 60)}m`;
}

/**
 * A short label for what the connection is doing right now: the step of the
 * attempt in progress, or the countdown to the next one. Every surface that
 * shows a connection's state uses it, so they agree. `nowMs` drives the
 * countdown; callers that do not tick get the value at render time.
 */
export function connectionProgressLabel(
  connection: EnvironmentConnectionPresentation,
  nowMs: number,
): string {
  connection = reconcileSshConnectionPresentation(connection);
  const phase = preparationLabel(connection);
  if (phase !== undefined) return phase;
  switch (connection.phase) {
    case "connecting":
    case "reconnecting": {
      if (connection.unreachable) {
        const seconds =
          connection.retryAt == null ? 0 : Math.ceil((connection.retryAt - nowMs) / 1000);
        return seconds > 0
          ? `Unreachable, retrying in ${formatRetryDelay(seconds)}`
          : "Unreachable, retrying";
      }
      if (connection.retryAt != null) {
        const seconds = Math.ceil((connection.retryAt - nowMs) / 1000);
        return seconds > 0 ? `Retrying in ${formatRetryDelay(seconds)}` : "Retrying";
      }
      switch (connection.stage) {
        case "opening":
          return "Opening connection";
        case "synchronizing":
          return "Syncing";
        default:
          return connection.phase === "connecting" ? "Connecting" : "Reconnecting";
      }
    }
    case "connected":
      return "Connected";
    case "offline":
      return "Offline";
    case "available":
      return "Not connected";
    case "unsupported":
      return "Client not supported";
    case "error":
      return "Connection failed";
  }
}

export function presentEnvironmentConnection(
  state: SupervisorConnectionState,
  runtimeStatus?: SshHostStatus,
): EnvironmentConnectionPresentation {
  return presentConnectionState(state, runtimeStatus);
}

/**
 * SSH connections ride a local forward that disappears with the client, so they have no stable
 * address.
 */
export function environmentMcpUrl(input: {
  readonly entry: ConnectionCatalogEntry;
  readonly relayHttpBaseUrl?: string | undefined;
  readonly connectedTarget?: ConnectionTarget | null | undefined;
}): string | null {
  const connectedRouteId = input.connectedTarget ? connectionRouteId(input.connectedTarget) : null;
  const routes = connectionRoutes(input.entry);
  const connectedRoute = routes.find(
    (route) => connectionRouteId(route.target) === connectedRouteId,
  );
  if (connectedRoute?.target._tag === "HubProxyConnectionTarget") return null;
  for (const route of connectedRoute ? [connectedRoute, ...routes] : routes) {
    const httpBaseUrl =
      route.target._tag === "RelayConnectionTarget"
        ? (input.relayHttpBaseUrl ?? null)
        : routeHttpBaseUrl(route);
    const mcpUrl = httpBaseUrl === null ? null : mcpUrlFromBase(httpBaseUrl);
    if (mcpUrl !== null) return mcpUrl;
  }
  return null;
}

function mcpUrlFromBase(httpBaseUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(httpBaseUrl);
  } catch {
    return null;
  }
  url.pathname = "/mcp";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function connectionCatalogDisplayUrl(entry: ConnectionCatalogEntry): string | null {
  switch (entry.target._tag) {
    case "PrimaryConnectionTarget":
      return entry.target.httpBaseUrl;
    case "RelayConnectionTarget":
    case "HubProxyConnectionTarget":
      return null;
    case "BearerConnectionTarget":
      return Option.isSome(entry.profile) && entry.profile.value._tag === "BearerConnectionProfile"
        ? entry.profile.value.httpBaseUrl
        : null;
    case "SshConnectionTarget":
      return Option.isSome(entry.profile) && entry.profile.value._tag === "SshConnectionProfile"
        ? `${entry.profile.value.target.username}@${entry.profile.value.target.hostname}`
        : null;
  }
}
