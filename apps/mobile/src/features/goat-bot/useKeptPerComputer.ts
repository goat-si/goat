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
  KEPT_KINDS,
  computerKey,
  connectionRefusedAtom,
  keptAtom,
  refuseConnection,
  refuseList,
  setReadRefresher,
  staleAtom,
  startOver,
  type KeptKind,
} from "./keptPerComputerStore";
import { openAsks } from "./openAsksRead";

export { resetKeptPerComputerForTests } from "./keptPerComputerStore";

const NO_KEPT = Atom.make<unknown>(null);
const NOT_STALE = Atom.make(false);
const NOT_READABLE = Atom.make(false);
// Derived in the same pass as the roster's own read, so no reader shows a line after a refusal.
const readableAtom = Atom.family((key: string) => {
  const environmentId = key.slice(key.indexOf(":") + 1) as EnvironmentId;
  return Atom.make((get) => {
    if (!get(environmentCatalog.catalogValueAtom).entries.has(environmentId)) return false;
    if (get(connectionRefusedAtom(environmentId))) return false;
    const presentation = get(environmentPresentations.presentationsAtom).get(environmentId);
    const capabilities = presentation?.serverConfig?.environment.capabilities;
    // Only a computer that lists bots can answer the read that ends a list refusal.
    if (capabilities?.goatBotProfiles !== true) return true;
    if (get(staleAtom("bots", environmentId))) return false;
    if (presentation?.connection.phase !== "connected") return true;
    // The bot list the roster reads, shared: refused in the render it arrives.
    const list = get(
      channelEnvironment.listBots({
        environmentId,
        input: capabilities.goatBotMembers === true ? { includeDeleted: true } : {},
      }),
    );
    return !(list._tag === "Failure" && accessDenied(Cause.squash(list.cause)));
  });
});

// The reads of each kind; a refresh replaces whatever request of theirs is in flight.
const readsOf = (
  environmentId: EnvironmentId,
  kind: KeptKind,
): ReadonlyArray<Atom.Atom<unknown>> =>
  kind === "asks"
    ? [openAsks({ environmentId, input: {} })]
    : [
        channelEnvironment.listBots({ environmentId, input: {} }),
        channelEnvironment.listBots({ environmentId, input: { includeDeleted: true } }),
      ];

/**
 * Installed once with the app's registry: a computer that leaves the catalog, or whose connection
 * refuses this phone, starts its reads over; a refused connection holds until it next connects.
 * Returns the way to stop following.
 */
export function followKeptPerComputerCatalog(registry: AtomRegistry.AtomRegistry): () => void {
  setReadRefresher(registry, (environmentId, kind) => {
    for (const read of readsOf(environmentId, kind)) registry.refresh(read);
  });
  let known = new Set<EnvironmentId>();
  const stopCatalog = registry.subscribe(
    environmentCatalog.catalogValueAtom,
    (catalog) => {
      const now = new Set(catalog.entries.keys());
      for (const environmentId of known)
        if (!now.has(environmentId)) {
          registry.set(connectionRefusedAtom(environmentId), false);
          for (const kind of KEPT_KINDS) startOver(registry, environmentId, kind);
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
        const refused = connectionRefusedAtom(environmentId);
        if (connection.phase === "connected") {
          if (!connected.has(environmentId) && registry.get(refused)) registry.set(refused, false);
          connected.add(environmentId);
          continue;
        }
        connected.delete(environmentId);
        const reason = "failure" in connection ? connection.failure?.reason : null;
        if ((reason === "authentication" || reason === "permission") && !registry.get(refused))
          refuseConnection(registry, environmentId);
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
 * successful one this phone read from that computer. Nothing while the computer is unreadable, this
 * read is refused, or it is starting over. A success still marked waiting (a refresh in flight) is
 * kept too: its value is the server's last answer, and a refresh that never finishes keeps it.
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
  const stale = useAtomValue(environmentId === null ? NOT_STALE : staleAtom(kind, environmentId));
  // Starting over, only a settled answer seen while the flag was already set ends it.
  const answered = stale && live.successResult !== null;
  const settled = live.isSuccess ? live.data : null;
  const denied = accessDenied(live.cause);
  // oxlint-disable-next-line goat/react-effect-budget -- Remember each computer's last answer so it still reads after that computer drops.
  useEffect(() => {
    if (environmentId === null) return;
    // The bot list speaks for the whole computer: refused, nothing of it shows until a list settles.
    if (kind === "bots" && denied) {
      if (!stale) refuseList(registry, environmentId);
      return;
    }
    if (answered) {
      registry.set(staleAtom(kind, environmentId), false);
      return;
    }
    if (stale || denied || !readable) {
      if (stored !== null) store(null);
      return;
    }
    // The computer may have left the catalog or refused this phone since this render.
    const unchanged =
      registry.get(environmentCatalog.catalogValueAtom).entries.has(environmentId) &&
      !registry.get(staleAtom(kind, environmentId)) &&
      !registry.get(connectionRefusedAtom(environmentId));
    if (unchanged && settled !== null && settled !== stored) store(settled);
  }, [registry, environmentId, kind, settled, stored, stale, answered, denied, readable, store]);
  if (stale || denied || !readable) return null;
  if (!offline || live.data !== null) return live.data;
  return stored;
}

/**
 * Whether this phone may still read the computer: it is in the app's catalog, its connection has
 * not been refused since it last connected, and its bot list is not refused or starting over.
 * Kept answers and cached messages from it show only while this holds.
 */
export function useComputerReadable(environmentId: EnvironmentId | null): boolean {
  return useAtomValue(
    environmentId === null ? NOT_READABLE : readableAtom(computerKey(environmentId)),
  );
}
