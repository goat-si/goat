import { accessDenied } from "@goat/client-runtime/goatBot";
import type { EnvironmentId } from "@goat/contracts";
import { useEffect } from "react";

import type { EnvironmentQueryView } from "../../state/query";

// The last settled answer of a read, per computer, so the bot list and open asks still read while
// that computer is offline. Kept for the app's life; an answer denying access forgets it.
const kept = new Map<string, unknown>();

export function resetKeptPerComputerForTests() {
  kept.clear();
}

/**
 * The live answer while the computer is connected; offline, the live answer if any, else the last
 * settled one this phone read from that computer. Only settled successes are kept, so an older read
 * still waiting never replaces a newer answer.
 */
export function useKeptPerComputer<A>(
  kind: "bots" | "asks",
  environmentId: EnvironmentId | null,
  live: EnvironmentQueryView<A>,
  offline: boolean,
): A | null {
  const key = environmentId === null ? null : `${kind}:${environmentId}`;
  const settled = live.successResult?.value ?? null;
  const denied = accessDenied(live.cause);
  // oxlint-disable-next-line goat/react-effect-budget -- Remember each computer's last answer outside React so it still reads after that computer drops.
  useEffect(() => {
    if (key === null) return;
    if (denied) kept.delete(key);
    else if (settled !== null) kept.set(key, settled);
  }, [key, settled, denied]);
  if (!offline || live.data !== null || key === null) return live.data;
  return (kept.get(key) as A | undefined) ?? null;
}
