import { toServerClock } from "@goat/client-runtime/clock";
import type { EnvironmentId } from "@goat/contracts";
import { formatDuration } from "@goat/shared/orchestrationTiming";

function formatWorkingTimer(startIso: string, endIso: string): string | null {
  const startedAtMs = Date.parse(startIso);
  const endedAtMs = Date.parse(endIso);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) {
    return null;
  }

  const elapsedSeconds = Math.max(0, Math.floor((endedAtMs - startedAtMs) / 1000));
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s`;
  }

  return formatDuration(elapsedSeconds * 1_000);
}

export function formatWorkingTimerNow(startIso: string, environmentId: EnvironmentId): string {
  return (
    formatWorkingTimer(
      startIso,
      new Date(toServerClock(environmentId, Date.now())).toISOString(),
    ) ?? "0s"
  );
}
