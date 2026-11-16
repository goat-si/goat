import { useAtomSet, useAtomValue, RegistryContext } from "@effect/atom-react";
import { accessDenied } from "@goat/client-runtime/goatBot";
import type { EnvironmentId } from "@goat/contracts";
import * as Cause from "effect/Cause";
import { Atom, type AtomRegistry } from "effect/reactivity";
import { useContext, useEffect } from "react";

import { environmentCatalog } from "../../connection/catalog";
import { channelEnvironment } from "../../state/channels";
import { environmentPresentations } from "../../state/presentation";
import type { EnvironmentQueryView } from "../../state/query";
import {
  computerKey,
  connectionRefusedAtom,
  forgetKept,
  keptAtom,
  listRefusedAtom,
  refuseComputer,
  removalAtom,
  type Removal,
  type KeptKind,
} from "./keptPerComputerStore";

export { resetKeptPerComputerForTests } from "./keptPerComputerStore";

const NO_KEPT = Atom.make<unknown>(null);
// Derived in the same pass as the roster's own read, so no reader shows a line after a refusal.
const readableAtom = Atom.family((key: string) => {
  const environmentId = key.slice(key.indexOf(":") + 1) as EnvironmentId;
  return Atom.make(
    (get) =>
      get(environmentCatalog.catalogValueAtom).entries.has(environmentId) &&
      get(connectionRefusedAtom(key)) === null &&
      get(listRefusedAtom(key)) === null &&
      !currentListDenied(get, environmentId),
  );
});
const NOT_READABLE = Atom.make(false);
const NO_REMOVAL = Atom.make<Removal | null>(null);
// When each answer's data last settled. A waiting read or a refusal still carries an earlier
// answer's data; it counts from when that answer settled, never from now.
const settledAt = new WeakMap<object, number>();

/** When the data this read shows last settled, or null when no settled answer carried it. */
function lastSettled<A>(live: EnvironmentQueryView<A>): number | null {
  const data = live.data;
  if (typeof data !== "object" || data === null) return null;
  const success = live.successResult;
  if (success !== null && success.value === data && typeof success.timestamp === "number")
    settledAt.set(data, Math.max(success.timestamp, settledAt.get(data) ?? success.timestamp));
  return settledAt.get(data) ?? null;
}

/** The bot list the roster reads, shared: refused while the computer is connected and lists bots. */
function currentListDenied(get: Atom.AtomContext, environmentId: EnvironmentId): boolean {
  const presentation = get(environmentPresentations.presentationsAtom).get(environmentId);
  const capabilities = presentation?.serverConfig?.environment.capabilities;
  if (presentation?.connection.phase !== "connected" || capabilities?.goatBotProfiles !== true)
    return false;
  const list = get(
    channelEnvironment.listBots({
      environmentId,
      input: capabilities.goatBotMembers === true ? { includeDeleted: true } : {},
    }),
  );
  return list._tag === "Failure" && accessDenied(Cause.squash(list.cause));
}

/**
 * Installed once with the app's registry: a computer that leaves the catalog loses what was kept
 * for it, and one whose connection is refused is marked so until it next connects. Returns the
 * way to stop following.
 */
export function followKeptPerComputerCatalog(registry: AtomRegistry.AtomRegistry): () => void {
  let known = new Set<EnvironmentId>();
  const stopCatalog = registry.subscribe(
    environmentCatalog.catalogValueAtom,
    (catalog) => {
      const now = new Set(catalog.entries.keys());
      for (const environmentId of known)
        if (!now.has(environmentId)) {
          const removal = removalAtom(environmentId);
          const count = (registry.get(removal)?.count ?? 0) + 1;
          registry.set(removal, { count, at: Date.now() });
          forgetKept(registry, environmentId);
          registry.set(connectionRefusedAtom(computerKey(environmentId)), null);
          registry.set(listRefusedAtom(computerKey(environmentId)), null);
        }
      known = now;
    },
    { immediate: true },
  );
  const connected = new Set<EnvironmentId>();
  const stopConnections = registry.subscribe(
    environmentPresentations.presentationsAtom,
    (presentations) => {
      for (const [environmentId, { connection }] of presentations) {
        const refused = connectionRefusedAtom(computerKey(environmentId));
        if (connection.phase === "connected") {
          if (!connected.has(environmentId) && registry.get(refused) !== null)
            registry.set(refused, null);
          connected.add(environmentId);
          continue;
        }
        connected.delete(environmentId);
        const reason = "failure" in connection ? connection.failure?.reason : null;
        const refusal = reason === "authentication" || reason === "permission";
        if (refusal && registry.get(refused) === null)
          refuseComputer(registry, environmentId, refused);
      }
    },
    { immediate: true },
  );
  return () => {
    stopCatalog();
    stopConnections();
  };
}

/**
 * The live answer while the computer is connected; offline, the live answer if any, else the last
 * successful one this phone read from that computer. Nothing while the computer is unreadable or
 * this read is refused. A success still marked waiting (a refresh in flight) is written too: its
 * value is the server's last answer, and a refresh that never finishes must not leave nothing kept.
 */
export function useKeptPerComputer<A>(
  kind: KeptKind,
  environmentId: EnvironmentId | null,
  live: EnvironmentQueryView<A>,
  offline: boolean,
): A | null {
  const registry = useContext(RegistryContext);
  const readable = useComputerReadable(environmentId);
  const atom = environmentId === null ? NO_KEPT : keptAtom(kind, environmentId);
  const stored = useAtomValue(atom) as A | null;
  const store = useAtomSet(atom as Atom.Writable<unknown>);
  // An answer counts once it settled after the computer last left the catalog and, for clearing a
  // refused bot list, after that refusal.
  const settledTime = lastSettled(live);
  const removal = useAtomValue(environmentId === null ? NO_REMOVAL : removalAtom(environmentId));
  const data =
    removal === null || (settledTime !== null && settledTime > removal.at) ? live.data : null;
  const settled = live.isSuccess ? data : null;
  const denied = accessDenied(live.cause);
  const removalsAtRender = removal?.count ?? 0;
  // oxlint-disable-next-line goat/react-effect-budget -- Remember each computer's last answer so it still reads after that computer drops.
  useEffect(() => {
    if (environmentId === null) return;
    // The bot list speaks for the whole computer: refused, nothing of it shows until a list answers.
    const listRefused = listRefusedAtom(computerKey(environmentId));
    if (kind === "bots" && denied) {
      refuseComputer(registry, environmentId, listRefused);
      return;
    }
    const listRefusedAt = registry.get(listRefused);
    if (
      kind === "bots" &&
      listRefusedAt !== null &&
      settledTime !== null &&
      settledTime > listRefusedAt
    )
      registry.set(listRefused, null);
    if (denied || !readable) {
      if (stored !== null) store(null);
      return;
    }
    // The computer may have left the catalog since this render, and even come back, or refused this
    // phone: its answer from before is not kept then.
    const unchanged =
      registry.get(environmentCatalog.catalogValueAtom).entries.has(environmentId) &&
      (registry.get(removalAtom(environmentId))?.count ?? 0) === removalsAtRender &&
      registry.get(connectionRefusedAtom(computerKey(environmentId))) === null &&
      registry.get(listRefused) === null;
    if (unchanged && settled !== null && settled !== stored) store(settled);
  }, [
    registry,
    environmentId,
    kind,
    settled,
    settledTime,
    stored,
    denied,
    readable,
    store,
    removalsAtRender,
  ]);
  if (denied || !readable) return null;
  if (!offline || data !== null) return data;
  return stored;
}

/**
 * Whether this phone may still read the computer: it is in the app's catalog, its connection has
 * not been refused since it last connected, and its bot list is not refused. Kept answers and
 * cached messages from it show only while this holds.
 */
export function useComputerReadable(environmentId: EnvironmentId | null): boolean {
  return useAtomValue(
    environmentId === null ? NOT_READABLE : readableAtom(computerKey(environmentId)),
  );
}
