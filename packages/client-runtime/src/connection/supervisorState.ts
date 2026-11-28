import {
  NO_REFUSED_ROUTES,
  type ConnectionFailure,
  type NetworkStatus,
  type SupervisorConnectionState,
} from "./model.ts";

export interface SupervisorIntent {
  readonly desired: boolean;
  readonly network: NetworkStatus;
}

export function mergeRefusedRoutes(
  known: ReadonlyArray<string>,
  refused: ReadonlyArray<string>,
  keep: (routeId: string) => boolean,
): ReadonlyArray<string> {
  const next = [...new Set([...known, ...refused])].filter(keep);
  return next.length === known.length && next.every((id, index) => id === known[index])
    ? known
    : next;
}

export function availableState(
  intent: SupervisorIntent,
  generation: number,
): SupervisorConnectionState {
  return {
    desired: false,
    network: intent.network,
    phase: "available",
    stage: null,
    attempt: 0,
    generation,
    lastFailure: null,
    retryAt: null,
    refusedRouteIds: NO_REFUSED_ROUTES,
  };
}

export function offlineState(
  intent: SupervisorIntent,
  generation: number,
  attempt: number,
  lastFailure: ConnectionFailure | null,
): SupervisorConnectionState {
  return {
    desired: true,
    network: intent.network,
    phase: "offline",
    stage: null,
    attempt,
    generation,
    lastFailure,
    retryAt: null,
    refusedRouteIds: NO_REFUSED_ROUTES,
  };
}

export function connectingState(
  intent: SupervisorIntent,
  generation: number,
  attempt: number,
  lastFailure: ConnectionFailure | null,
  stage: SupervisorConnectionState["stage"] = "preparing",
): SupervisorConnectionState {
  return {
    desired: true,
    network: intent.network,
    phase: "connecting",
    stage,
    attempt,
    generation,
    lastFailure,
    retryAt: null,
    refusedRouteIds: NO_REFUSED_ROUTES,
  };
}
