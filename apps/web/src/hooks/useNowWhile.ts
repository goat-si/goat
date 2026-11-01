import { useEffect, useState } from "react";

/**
 * The current time, re-read every intervalMs only while active, for elapsed labels on things
 * that are in progress. Idle views do not re-render; while inactive it keeps the last reading.
 */
export function useNowWhile(active: boolean, intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const tick = () => setNow(Date.now());
    const first = window.setTimeout(tick, 0);
    const timer = window.setInterval(tick, intervalMs);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [active, intervalMs]);
  return now;
}
