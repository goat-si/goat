import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { accessDenied } from "@goat/client-runtime/goatBot";
import type { EnvironmentId } from "@goat/contracts";
import { Atom } from "effect/reactivity";
import { useEffect } from "react";

import type { EnvironmentQueryView } from "../../state/query";

// The last successful answer of a read, per computer, so the bot list and open asks still read while
// that computer is offline. Kept for the app's life; an answer denying access forgets it.
let generation = 0;
const keptAtom = Atom.family((_key: string) => Atom.make<unknown>(null).pipe(Atom.keepAlive));
const NO_KEPT = Atom.make<unknown>(null);

export function resetKeptPerComputerForTests() {
  generation += 1;
}

/**
 * The live answer while the computer is connected; offline, the live answer if any, else the last
 * successful one this phone read from that computer. The read's value is its newest answer, also
 * while a refresh is in flight, so a refresh that never answers cannot leave nothing kept.
 */
export function useKeptPerComputer<A>(
  kind: "bots" | "asks",
  environmentId: EnvironmentId | null,
  live: EnvironmentQueryView<A>,
  offline: boolean,
): A | null {
  const atom =
    environmentId === null ? NO_KEPT : keptAtom(`${generation}:${kind}:${environmentId}`);
  const stored = useAtomValue(atom) as A | null;
  const store = useAtomSet(atom as Atom.Writable<unknown>);
  const settled = live.isSuccess ? live.data : null;
  const denied = accessDenied(live.cause);
  // oxlint-disable-next-line goat/react-effect-budget -- Remember each computer's last answer so it still reads after that computer drops.
  useEffect(() => {
    if (environmentId === null) return;
    if (denied) {
      if (stored !== null) store(null);
    } else if (settled !== null && settled !== stored) store(settled);
  }, [environmentId, settled, stored, denied, store]);
  if (!offline || live.data !== null) return live.data;
  return stored;
}
