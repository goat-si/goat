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
// A refusal is the time it was recorded, so only an answer that settled later clears it.
const flagFamily = Atom.family((_key: string) =>
  Atom.make<number | null>(null).pipe(Atom.keepAlive),
);

export const keptAtom = (kind: KeptKind, environmentId: EnvironmentId) =>
  keptFamily(`${generation}:${kind}:${environmentId}`);
/** Keys one computer in this generation; the refusal flags below are found by it. */
export const computerKey = (environmentId: EnvironmentId) => `${generation}:${environmentId}`;
// Refused by the computer's connection (credential or scope), or its account signed out; only
// reaching "connected" again clears it.
export const connectionRefusedAtom = (key: string) => flagFamily(`connection:${key}`);
// The computer's bot list was refused; only a bot list that settles after the refusal clears it.
export const listRefusedAtom = (key: string) => flagFamily(`list:${key}`);

// How many times the computer has left the catalog, and when it last did. A write prepared before a
// removal is dropped, and an answer settled before it is not shown.
export type Removal = { readonly count: number; readonly at: number };
const removalFamily = Atom.family((_key: string) =>
  Atom.make<Removal | null>(null).pipe(Atom.keepAlive),
);
export const removalAtom = (environmentId: EnvironmentId) =>
  removalFamily(computerKey(environmentId));

export function resetKeptPerComputerForTests() {
  generation += 1;
}

export function forgetKept(registry: AtomRegistry.AtomRegistry, environmentId: EnvironmentId) {
  for (const kind of KEPT_KINDS) registry.set(keptAtom(kind, environmentId), null);
}

/** Refused: everything kept for the computer goes, a create held for it too, and it stays refused. */
export function refuseComputer(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  flag: Atom.Writable<number | null>,
) {
  registry.set(flag, Date.now());
  forgetKept(registry, environmentId);
  forgetNewBotEnvironment(environmentId);
}

/**
 * On sign-out: a computer this phone reaches only through the relay reads as refused until it
 * connects again; one with another route stays readable.
 */
export function refuseRelayOnlyComputers(registry: AtomRegistry.AtomRegistry): void {
  for (const [environmentId, entry] of registry.get(environmentCatalog.catalogValueAtom).entries)
    if (removedWithRelay(entry))
      refuseComputer(registry, environmentId, connectionRefusedAtom(computerKey(environmentId)));
}
