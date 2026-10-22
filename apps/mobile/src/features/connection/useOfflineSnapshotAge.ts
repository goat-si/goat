import { offlineSnapshotAgeLabel } from "@goat/client-runtime/connection";
import type { EnvironmentId } from "@goat/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useState } from "react";

import { environmentShell } from "../../state/shell";

/**
 * "last state N min ago" for an environment that is not connected, when the threads shown for it
 * carry their capture time. Ticks once a minute only while it is shown.
 */
export function useOfflineSnapshotAge(
  environmentId: EnvironmentId,
  connected: boolean,
): string | null {
  const capturedAt = useAtomValue(environmentShell.offlineSnapshotAge(environmentId));
  const [nowMs, setNowMs] = useState(() => Date.now());
  const visible = !connected && capturedAt !== null;
  useEffect(() => {
    if (!visible) return;
    // Refresh right away when the label appears, then once a minute while it stays.
    const first = setTimeout(() => setNowMs(Date.now()), 0);
    const timer = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [visible]);
  return visible ? offlineSnapshotAgeLabel(capturedAt, nowMs) : null;
}
