import {
  connectionRowShowsSnapshotAge,
  connectionWaitsToRetry,
  offlineSnapshotAgeLabel,
  type EnvironmentConnectionPresentation,
} from "@goat/client-runtime/connection";
import type { EnvironmentId } from "@goat/contracts";
import { useEffect, useRef } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { useEnvironmentSnapshotCapturedAt } from "../../state/presentation";

/**
 * What a saved connection row needs to show live state. The snapshot age appears only while nothing
 * is trying to connect. Opening the row starts a retry that is waiting on its backoff, once, and
 * `refreshConnection` does the same for Refresh status.
 */
export function useConnectionRowLiveState(input: {
  readonly environmentId: EnvironmentId;
  readonly connection: EnvironmentConnectionPresentation;
  readonly enabled: boolean;
  readonly retry: () => void;
}) {
  const capturedAt = useEnvironmentSnapshotCapturedAt(input.environmentId);
  const nowMinute = useNowMinute();
  const waiting = input.enabled && connectionWaitsToRetry(input.connection);
  const retryOnOpen = useRef(waiting);
  useEffect(() => {
    if (!retryOnOpen.current) return;
    retryOnOpen.current = false;
    input.retry();
  });
  return {
    snapshotAge:
      input.enabled && connectionRowShowsSnapshotAge(input.connection)
        ? offlineSnapshotAgeLabel(capturedAt, Date.parse(`${nowMinute}:59.999Z`))
        : null,
    refreshConnection: waiting ? input.retry : undefined,
  };
}
