import {
  connectionProgressLabel,
  type EnvironmentConnectionPresentation,
} from "@goat/client-runtime/connection";
import { useEffect, useState } from "react";

/**
 * What an environment connection is doing right now ("Reconnecting",
 * "Retrying in 12s"). Only a countdown re-renders, once a second, and only
 * this label.
 */
export function EnvironmentConnectionProgressLabel({
  connection,
}: {
  connection: EnvironmentConnectionPresentation;
}) {
  if (connection.retryAt == null) return connectionProgressLabel(connection, 0);
  // A new retry time remounts the countdown, so it starts from the current clock.
  return (
    <RetryCountdownLabel
      key={connection.retryAt}
      connection={connection}
      retryAt={connection.retryAt}
    />
  );
}

function RetryCountdownLabel({
  connection,
  retryAt,
}: {
  connection: EnvironmentConnectionPresentation;
  retryAt: number;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const interval = window.setInterval(() => {
      const next = Date.now();
      setNowMs(next);
      if (next >= retryAt) window.clearInterval(interval);
    }, 1_000);
    return () => window.clearInterval(interval);
  }, [retryAt]);
  return connectionProgressLabel(connection, nowMs);
}
