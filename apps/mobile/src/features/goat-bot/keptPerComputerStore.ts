import { forgetNewBotEnvironment } from "@goat/client-runtime/goatBot";
import { removedWithRelay } from "@goat/client-runtime/connection";
import type { EnvironmentId } from "@goat/contracts";
import { Atom, type AtomRegistry } from "effect/reactivity";

import { environmentCatalog } from "../../connection/catalog";

// The last successful answer of a read, per computer, so the bot list and open asks still read while
// that computer is offline, and whether the computer refused this phone. Apart from the readers, so
// sign-out can mark a computer refused without loading them.
export const KEPT_KINDS = ["bots", "asks"] as const;
export type KeptKind = (typeof KEPT_KINDS)[number];
let generation = 0;
const keptFamily = Atom.family((_key: string) => Atom.make<unknown>(null).pipe(Atom.keepAlive));
const flagFamily = Atom.family((_key: string) => Atom.make(false).pipe(Atom.keepAlive));
const restartFamily = Atom.family((_key: string) =>
  Atom.make<number | null>(null).pipe(Atom.keepAlive),
);
let restarts = 0;
/** Keys one computer in this generation. */
export const computerKey = (environmentId: EnvironmentId) => `${generation}:${environmentId}`;
export const keptAtom = (kind: KeptKind, environmentId: EnvironmentId) =>
  keptFamily(`${kind}:${computerKey(environmentId)}`);
// The restart a refusal or removal began, null when fresh: the read shows and keeps nothing until
// an answer settles during that same restart.
export const staleAtom = (kind: KeptKind, environmentId: EnvironmentId) =>
  restartFamily(`${kind}:${computerKey(environmentId)}`);
// Refused by the computer's connection, or its account signed out; reaching "connected" clears it.
export const connectionRefusedAtom = (environmentId: EnvironmentId) =>
  flagFamily(`connection:${computerKey(environmentId)}`);
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

/** The read starts over: what is in flight is interrupted first, so no answer from before counts. */
export function startOver(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  kind: KeptKind,
  refresh = true,
) {
  if (refresh) refreshers.get(registry)?.(environmentId, kind);
  registry.set(keptAtom(kind, environmentId), null);
  registry.set(staleAtom(kind, environmentId), ++restarts);
}

/** The connection refused this phone, or the account that reached the computer signed out. */
export function refuseConnection(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
) {
  registry.set(connectionRefusedAtom(environmentId), true);
  for (const kind of KEPT_KINDS) startOver(registry, environmentId, kind);
  forgetNewBotEnvironment(environmentId);
}

/**
 * The bot list was refused. That refusal is its query's latest answer, with nothing in flight, so
 * the list starts over without a new request; the asks are read again. A kind already starting
 * over is left as it is, so a refusal seen again starts nothing.
 */
export function refuseList(registry: AtomRegistry.AtomRegistry, environmentId: EnvironmentId) {
  if (registry.get(staleAtom("bots", environmentId)) === null)
    startOver(registry, environmentId, "bots", false);
  if (registry.get(staleAtom("asks", environmentId)) === null)
    startOver(registry, environmentId, "asks");
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
