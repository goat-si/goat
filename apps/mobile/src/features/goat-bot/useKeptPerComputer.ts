import { useAtomSet, useAtomValue, RegistryContext } from "@effect/atom-react";
import { accessDenied } from "@goat/client-runtime/goatBot";
import type { EnvironmentId } from "@goat/contracts";
import { Atom, type AtomRegistry } from "effect/reactivity";
import { useContext, useEffect } from "react";

import { environmentCatalog } from "../../connection/catalog";
import type { EnvironmentQueryView } from "../../state/query";

// The last successful answer of a read, per computer, so the bot list and open asks still read while
// that computer is offline. Kept while the computer is in the app's catalog: leaving the catalog,
// by any path, forgets it, and an answer denying access does too.
const KINDS = ["bots", "asks"] as const;
type Kind = (typeof KINDS)[number];
let generation = 0;
const keptAtom = Atom.family((_key: string) => Atom.make<unknown>(null).pipe(Atom.keepAlive));
const NO_KEPT = Atom.make<unknown>(null);
const keyOf = (kind: Kind, environmentId: EnvironmentId) =>
  `${generation}:${kind}:${environmentId}`;
// How many times each computer has left the catalog, per registry. A write prepared before a
// removal is dropped, even when the same computer has been added again since.
const removals = new WeakMap<AtomRegistry.AtomRegistry, Map<EnvironmentId, number>>();
const removalsOf = (registry: AtomRegistry.AtomRegistry, environmentId: EnvironmentId) =>
  removals.get(registry)?.get(environmentId) ?? 0;

export function resetKeptPerComputerForTests() {
  generation += 1;
}

function forget(registry: AtomRegistry.AtomRegistry, environmentId: EnvironmentId) {
  for (const kind of KINDS) registry.set(keptAtom(keyOf(kind, environmentId)), null);
}

/**
 * Installed once with the app's registry: a computer that leaves the catalog loses what was kept
 * for it. Returns the way to stop following.
 */
export function followKeptPerComputerCatalog(registry: AtomRegistry.AtomRegistry): () => void {
  const counts = new Map<EnvironmentId, number>();
  removals.set(registry, counts);
  let known = new Set<EnvironmentId>();
  return registry.subscribe(
    environmentCatalog.catalogValueAtom,
    (catalog) => {
      const now = new Set(catalog.entries.keys());
      for (const environmentId of known)
        if (!now.has(environmentId)) {
          counts.set(environmentId, (counts.get(environmentId) ?? 0) + 1);
          forget(registry, environmentId);
        }
      known = now;
    },
    { immediate: true },
  );
}

/**
 * The live answer while the computer is connected; offline, the live answer if any, else the last
 * successful one this phone read from that computer. A success still marked waiting (a refresh in
 * flight) is written too: its value is the server's last answer, and a refresh that never finishes
 * before the computer drops must not leave nothing kept.
 */
export function useKeptPerComputer<A>(
  kind: Kind,
  environmentId: EnvironmentId | null,
  live: EnvironmentQueryView<A>,
  offline: boolean,
): A | null {
  const registry = useContext(RegistryContext);
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const listed = environmentId !== null && catalog.entries.has(environmentId);
  const atom = environmentId === null ? NO_KEPT : keptAtom(keyOf(kind, environmentId));
  const stored = useAtomValue(atom) as A | null;
  const store = useAtomSet(atom as Atom.Writable<unknown>);
  const settled = listed && live.isSuccess ? live.data : null;
  const denied = accessDenied(live.cause);
  const removalsAtRender = environmentId === null ? 0 : removalsOf(registry, environmentId);
  // oxlint-disable-next-line goat/react-effect-budget -- Remember each computer's last answer so it still reads after that computer drops.
  useEffect(() => {
    if (environmentId === null) return;
    if (denied) {
      if (stored !== null) store(null);
      return;
    }
    // The computer may have left the catalog since this render, and even come back: its answer from
    // before is not kept then.
    const unchanged =
      registry.get(environmentCatalog.catalogValueAtom).entries.has(environmentId) &&
      removalsOf(registry, environmentId) === removalsAtRender;
    if (unchanged && settled !== null && settled !== stored) store(settled);
  }, [registry, environmentId, settled, stored, denied, store, removalsAtRender]);
  if (!offline || live.data !== null) return live.data;
  return listed ? stored : null;
}
