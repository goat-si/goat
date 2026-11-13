import { useState } from "react";

/**
 * The last answer read for this scope, kept while its computer is offline so the work it listed
 * stays readable. Nothing is fetched for it; callers close every control while offline.
 */
export function useKeptWhileOffline<T>(data: T | null, scope: string, offline: boolean): T | null {
  const [kept, setKept] = useState<{ scope: string; signature: string; data: T } | null>(null);
  const signature = data === null ? null : JSON.stringify(data);
  if (
    signature !== null &&
    data !== null &&
    (kept?.scope !== scope || kept.signature !== signature)
  )
    setKept({ scope, signature, data });
  return data ?? (offline && kept?.scope === scope ? kept.data : null);
}
