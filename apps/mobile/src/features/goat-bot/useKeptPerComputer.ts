import { useAtomSet, useAtomValue, RegistryContext } from "@effect/atom-react";
import { accessDenied } from "@goat/client-runtime/goatBot";
import type { EnvironmentPresentation } from "@goat/client-runtime/connection";
import type { EnvironmentId } from "@goat/contracts";
import { Atom, type AtomRegistry } from "effect/reactivity";
import { useContext, useEffect } from "react";

import { environmentCatalog } from "../../connection/catalog";
import type { EnvironmentQueryView } from "../../state/query";

// The last successful answer of a read, per computer, so the bot list, open asks and each member's
// status still read while that computer is offline. Kept while the computer is in the app's
// catalog: leaving the catalog, by any path, forgets it, and an answer denying access does too.
const KINDS = ["bots", "asks", "status"] as const;
type Kind = (typeof KINDS)[number];
let generation = 0;
const keptAtom = Atom.family((_key: string) => Atom.make<unknown>(null).pipe(Atom.keepAlive));
const NO_KEPT = Atom.make<unknown>(null);
const keyOf = (kind: Kind, environmentId: EnvironmentId, part?: string) =>
  `${generation}:${kind}:${environmentId}${part === undefined ? "" : `:${part}`}`;
// Whether the computer last refused this phone, by its connection or its bot list. The connection
// keeps a refusal only as its last failure, which the next unreachable attempt replaces; this keeps
// it until a bot-list read succeeds, and until then nothing of that computer shows, kept or live.
const deniedAtom = Atom.family((_key: string) => Atom.make(false).pipe(Atom.keepAlive));
const NOT_DENIED = Atom.make(false);
const deniedKeyOf = (environmentId: EnvironmentId) => `${generation}:${environmentId}`;
// How many times each computer has left the catalog, per registry. A write prepared before a
// removal is dropped, even when the same computer has been added again since.
const removals = new WeakMap<AtomRegistry.AtomRegistry, Map<EnvironmentId, number>>();
const removalsOf = (registry: AtomRegistry.AtomRegistry, environmentId: EnvironmentId) =>
  removals.get(registry)?.get(environmentId) ?? 0;
// The per-bot keys written for each computer, so forgetting the computer reaches every one.
const parts = new WeakMap<AtomRegistry.AtomRegistry, Map<EnvironmentId, Set<string>>>();

export function resetKeptPerComputerForTests() {
  generation += 1;
}

function forget(registry: AtomRegistry.AtomRegistry, environmentId: EnvironmentId) {
  for (const kind of KINDS) registry.set(keptAtom(keyOf(kind, environmentId)), null);
  for (const key of parts.get(registry)?.get(environmentId) ?? [])
    registry.set(keptAtom(key), null);
  parts.get(registry)?.delete(environmentId);
  registry.set(deniedAtom(deniedKeyOf(environmentId)), false);
}

/**
 * Installed once with the app's registry: a computer that leaves the catalog loses what was kept
 * for it. Returns the way to stop following.
 */
export function followKeptPerComputerCatalog(
  registry: AtomRegistry.AtomRegistry,
  connections?: Atom.Atom<ReadonlyMap<EnvironmentId, Pick<EnvironmentPresentation, "connection">>>,
): () => void {
  const counts = new Map<EnvironmentId, number>();
  removals.set(registry, counts);
  let known = new Set<EnvironmentId>();
  const stopCatalog = registry.subscribe(
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
  // A refusal is seen here whatever is on screen, so nothing from that computer shows afterwards.
  const stopRefusals =
    connections === undefined
      ? () => {}
      : registry.subscribe(
          connections,
          (presentations) => {
            for (const [environmentId, presentation] of presentations) {
              const denied = deniedAtom(deniedKeyOf(environmentId));
              if (!refusedConnection(presentation.connection) || registry.get(denied)) continue;
              forget(registry, environmentId);
              registry.set(denied, true);
            }
          },
          { immediate: true },
        );
  return () => {
    stopCatalog();
    stopRefusals();
  };
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
  /** Keeps one answer per part of the computer (a member's status, by bot id). */
  part?: string,
): A | null {
  const registry = useContext(RegistryContext);
  const readable = useComputerReadable(environmentId);
  const setComputerDenied = useAtomSet(
    (environmentId === null
      ? NOT_DENIED
      : deniedAtom(deniedKeyOf(environmentId))) as Atom.Writable<boolean>,
  );
  const key = environmentId === null ? null : keyOf(kind, environmentId, part);
  const atom = key === null ? NO_KEPT : keptAtom(key);
  const stored = useAtomValue(atom) as A | null;
  const store = useAtomSet(atom as Atom.Writable<unknown>);
  const settled = live.isSuccess ? live.data : null;
  const denied = accessDenied(live.cause);
  const removalsAtRender = environmentId === null ? 0 : removalsOf(registry, environmentId);
  // oxlint-disable-next-line goat/react-effect-budget -- Remember each computer's last answer so it still reads after that computer drops.
  useEffect(() => {
    if (environmentId === null || key === null) return;
    // The bot list speaks for the whole computer: refused, nothing of it shows until a read succeeds.
    if (kind === "bots") {
      if (denied) setComputerDenied(true);
      else if (settled !== null) setComputerDenied(false);
    }
    if (denied || !readable) {
      if (stored !== null) store(null);
      return;
    }
    // The computer may have left the catalog since this render, and even come back: its answer from
    // before is not kept then.
    const unchanged =
      registry.get(environmentCatalog.catalogValueAtom).entries.has(environmentId) &&
      removalsOf(registry, environmentId) === removalsAtRender;
    if (!unchanged || settled === null || settled === stored) return;
    if (part !== undefined) {
      const computers = parts.get(registry) ?? new Map<EnvironmentId, Set<string>>();
      parts.set(registry, computers);
      computers.set(environmentId, (computers.get(environmentId) ?? new Set()).add(key));
    }
    store(settled);
  }, [
    registry,
    environmentId,
    key,
    kind,
    part,
    settled,
    stored,
    denied,
    readable,
    store,
    setComputerDenied,
    removalsAtRender,
  ]);
  // A refused read still holds its earlier answer; it is not shown.
  if (denied || !readable) return null;
  if (!offline || live.data !== null) return live.data;
  return stored;
}

/**
 * Whether this phone may still read the computer: it is in the app's catalog and has not been
 * refused since its last successful bot-list read, by its connection (a revoked phone only ever
 * sees that) or by the bot list. Kept answers and cached messages from it show only while this holds.
 */
export function useComputerReadable(environmentId: EnvironmentId | null): boolean {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const denied = useAtomValue(
    environmentId === null ? NOT_DENIED : deniedAtom(deniedKeyOf(environmentId)),
  );
  return environmentId !== null && catalog.entries.has(environmentId) && !denied;
}

/** The connection stopped because the computer refuses this phone's credential or scope. */
function refusedConnection(connection: EnvironmentPresentation["connection"]): boolean {
  const reason = "failure" in connection ? connection.failure?.reason : null;
  return reason === "authentication" || reason === "permission";
}
