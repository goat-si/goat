import { forgetNewBotEnvironment } from "@goat/client-runtime/goatBot";
import { removedWithRelay } from "@goat/client-runtime/connection";
import {
  ChannelListBotsResult,
  ChannelListOpenAsksResult,
  type EnvironmentId,
} from "@goat/contracts";
import * as Equal from "effect/Equal";
import { Atom, type AtomRegistry } from "effect/reactivity";
import * as Schema from "effect/Schema";

import { environmentCatalog } from "../../connection/catalog";
import { KEPT_KINDS, type KeptKind, type createKeptSummaryStore } from "./keptSummaryStore";

export { KEPT_KINDS, type KeptKind } from "./keptSummaryStore";

type Persistence = {
  readonly store: ReturnType<typeof createKeptSummaryStore>;
  readonly scopes: (
    registry: AtomRegistry.AtomRegistry,
    id: EnvironmentId,
    live: boolean,
  ) => Promise<ReadonlyArray<string>>;
  readonly accountAtom: Atom.Atom<string | null>;
};
const installed = new WeakMap<AtomRegistry.AtomRegistry, Persistence>();
export const getKeptSummaryPersistence = (registry: AtomRegistry.AtomRegistry) =>
  installed.get(registry);
export const keptSummaryChangeAtom = Atom.make(0).pipe(Atom.keepAlive);
const observed = new WeakSet<object>();
const isBots = Schema.is(ChannelListBotsResult);
const isAsks = Schema.is(ChannelListOpenAsksResult);
const noteSummaryChange = (registry: AtomRegistry.AtomRegistry) =>
  registry.update(keptSummaryChangeAtom, (value) => value + 1);
const reportStorageFailure = () => console.warn("Could not update the offline bot summary.");

export function installKeptSummaryPersistence(
  registry: AtomRegistry.AtomRegistry,
  persistence: Persistence,
): () => void {
  installed.set(registry, persistence);
  return () => {
    installed.delete(registry);
  };
}

export function rememberKeptAnswer(
  registry: AtomRegistry.AtomRegistry,
  id: EnvironmentId,
  kind: KeptKind,
  answer: { readonly timestamp: number; readonly value: unknown },
): void {
  const persistence = installed.get(registry);
  if (persistence === undefined || observed.has(answer)) return;
  observed.add(answer);
  const lease = persistence.store.lease(id);
  void persistence
    .scopes(registry, id, true)
    .then(async ([scope]) => {
      if (scope === undefined || !persistence.store.isCurrent(lease)) return;
      if (kind === "bots" && isBots(answer.value))
        await persistence.store.keep(lease, "bots", scope, answer.timestamp, answer.value);
      else if (kind === "asks" && isAsks(answer.value))
        await persistence.store.keep(lease, "asks", scope, answer.timestamp, answer.value);
      if (persistence.store.isCurrent(lease)) noteSummaryChange(registry);
    })
    .catch(reportStorageFailure);
}

export function purgeKeptSummary(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
): void {
  const persistence = installed.get(registry);
  if (persistence === undefined) return;
  void persistence.store.purge(environmentId).catch(reportStorageFailure);
  noteSummaryChange(registry);
}

export function purgeKeptSummaries(registry: AtomRegistry.AtomRegistry): void {
  const persistence = installed.get(registry);
  if (persistence === undefined) return;
  void persistence.store.purgeAll().catch(reportStorageFailure);
  // Direct pairings remain signed in. Refresh their queries to fence earlier answers while
  // retaining their in-memory profiles for the screens that can still read those computers.
  const refresh = refreshers.get(registry);
  for (const id of registry.get(environmentCatalog.catalogValueAtom).entries.keys()) {
    registry.set(keptReadEpochAtom(id), ++restarts);
    for (const kind of KEPT_KINDS) refresh?.(id, kind);
  }
  noteSummaryChange(registry);
}

let generation = 0;
const keptFamily = Atom.family((_key: string) => Atom.make<unknown>(null).pipe(Atom.keepAlive));
const flagFamily = Atom.family((_key: string) => Atom.make(false).pipe(Atom.keepAlive));
const restartFamily = Atom.family((_key: string) =>
  Atom.make<number | null>(null).pipe(Atom.keepAlive),
);
const epochFamily = Atom.family((_key: string) => Atom.make(0).pipe(Atom.keepAlive));
let restarts = 0;
/** Keys one computer in this generation. */
export const computerKey = (environmentId: EnvironmentId) => `${generation}:${environmentId}`;
export const keptReadEpochAtom = (environmentId: EnvironmentId) =>
  epochFamily(computerKey(environmentId));
export const keptAtom = (kind: KeptKind, environmentId: EnvironmentId) =>
  keptFamily(`${kind}:${computerKey(environmentId)}`);
// The restart a refusal or removal began, null when fresh: the read shows and keeps nothing until
// an answer settles during that same restart.
export const staleAtom = (kind: KeptKind, environmentId: EnvironmentId) =>
  restartFamily(`${kind}:${computerKey(environmentId)}`);
// Refused by the computer's connection, or its account signed out; reaching "connected" clears it.
export const connectionRefusedAtom = (environmentId: EnvironmentId) =>
  flagFamily(`connection:${computerKey(environmentId)}`);
/** The listed computers this phone counts as refusing it; an unlisted one never is. */
export const refusedComputersAtom = Atom.make((get) => {
  const refused = new Set<EnvironmentId>();
  for (const environmentId of get(environmentCatalog.catalogValueAtom).entries.keys())
    if (get(connectionRefusedAtom(environmentId))) refused.add(environmentId);
  return refused;
}).pipe(Atom.withEquality(Equal.equals));
// The follower's way to interrupt a computer's reads, so nothing in flight lands afterwards.
const refreshers = new WeakMap<
  AtomRegistry.AtomRegistry,
  (environmentId: EnvironmentId, kind: KeptKind) => void
>();
export const setReadRefresher = (
  registry: AtomRegistry.AtomRegistry,
  refresh: (environmentId: EnvironmentId, kind: KeptKind) => void,
) => refreshers.set(registry, refresh);

export function resetKeptPerComputerForTests() {
  generation += 1;
}

/** Fence the old result before refreshing the query so an earlier answer cannot be kept. */
export function startOver(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  kind: KeptKind,
  refresh = true,
) {
  const restart = ++restarts;
  registry.set(keptReadEpochAtom(environmentId), restart);
  registry.set(staleAtom(kind, environmentId), restart);
  registry.set(keptAtom(kind, environmentId), null);
  if (refresh) refreshers.get(registry)?.(environmentId, kind);
}

/** The connection refused this phone, or the account that reached the computer signed out. */
export function refuseConnection(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
) {
  registry.set(connectionRefusedAtom(environmentId), true);
  purgeKeptSummary(registry, environmentId);
  for (const kind of KEPT_KINDS) startOver(registry, environmentId, kind);
  forgetNewBotEnvironment(environmentId);
}

/**
 * One read refused this pairing. A sibling that answered before the refusal must be read again.
 * The refusing query keeps its failure, so observing the same refusal cannot cause a retry loop.
 */
export function refuseKeptRead(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  refusedKind: KeptKind,
) {
  const freshKinds = KEPT_KINDS.filter(
    (kind) => registry.get(staleAtom(kind, environmentId)) === null,
  );
  if (freshKinds.length === 0) return;
  purgeKeptSummary(registry, environmentId);
  for (const kind of freshKinds) startOver(registry, environmentId, kind, kind !== refusedKind);
  forgetNewBotEnvironment(environmentId);
}

/**
 * On sign-out: a computer this phone reaches only through the relay reads as refused until it
 * connects again; one with another route stays readable.
 */
export function refuseRelayOnlyComputers(registry: AtomRegistry.AtomRegistry): void {
  for (const [environmentId, entry] of registry.get(environmentCatalog.catalogValueAtom).entries)
    if (removedWithRelay(entry)) refuseConnection(registry, environmentId);
}
