import { GOAT_BOT_READING_LIMIT_MS } from "@goat/client-runtime/goatBot";
import { useEffect, useState } from "react";

/** One expiry timer; stale replying state never adds a row on the first render. */
export function useReplying(since: string | null, visible: boolean) {
  const [expiredFor, setExpiredFor] = useState<string | null>(null);
  const started = since === null ? Number.NaN : Date.parse(since);
  const deadline = started + GOAT_BOT_READING_LIMIT_MS;
  useEffect(() => {
    if (!visible || since === null || Number.isNaN(started)) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    const timer = setTimeout(() => setExpiredFor(since), remaining);
    return () => clearTimeout(timer);
  }, [since, started, deadline, visible]);
  // oxlint-disable-next-line react/purity -- Check the wall-clock deadline before mounting a transient timeline row.
  return visible && since !== null && expiredFor !== since && Date.now() < deadline;
}
