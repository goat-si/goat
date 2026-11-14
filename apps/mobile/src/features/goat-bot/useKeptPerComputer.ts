import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { accessDenied } from "@goat/client-runtime/goatBot";
import type { EnvironmentId } from "@goat/contracts";
import { Atom } from "effect/reactivity";
import { useEffect } from "react";

import { appAtomRegistry } from "../../state/atom-registry";
import type { EnvironmentQueryView } from "../../state/query";

// The last successful answer of a read, per computer, so the bot list and open asks still read while
// that computer is offline. Kept until the computer is removed or an answer denies access.
const KINDS = ["bots", "asks"] as const;
type Kind = (typeof KINDS)[number];
let generation = 0;
const keptAtom = Atom.family((_key: string) => Atom.make<unknown>(null).pipe(Atom.keepAlive));
const NO_KEPT = Atom.make<unknown>(null);
const keyOf = (kind: Kind, environmentId: EnvironmentId) =>
  `${generation}:${kind}:${environmentId}`;

export function resetKeptPerComputerForTests() {
  generation += 1;
}

/** Forget what was kept for a computer this phone no longer connects to. */
export function forgetKeptPerComputer(environmentId: EnvironmentId, registry = appAtomRegistry) {
  for (const kind of KINDS) registry.set(keptAtom(keyOf(kind, environmentId)), null);
}

/**
 * The live answer while the computer is connected; offline, the live answer if any, else the last
 * successful one this phone read from that computer. The read's value is its newest answer, also
 * while a refresh is in flight, so a refresh that never answers cannot leave nothing kept.
 */
export function useKeptPerComputer<A>(
  kind: Kind,
  environmentId: EnvironmentId | null,
  live: EnvironmentQueryView<A>,
  offline: boolean,
): A | null {
  const atom = environmentId === null ? NO_KEPT : keptAtom(keyOf(kind, environmentId));
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
