import { Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";

// The active desktop environment is the first source of published themes.
export function selectThemeEnvironment<Id extends string>(
  primaryId: Id | null,
  hostId: string | null,
  catalogIds: Iterable<Id>,
): Id | null {
  if (primaryId !== null) return primaryId;
  for (const id of catalogIds) {
    if (id === hostId) return id;
  }
  return null;
}

export const hostEnvironmentIdAtom = Atom.make<string | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("web-host-environment-id"),
);

export const themeEnvironmentIdAtom = Atom.make((get) =>
  selectThemeEnvironment(
    get(primaryEnvironmentIdAtom),
    get(hostEnvironmentIdAtom),
    get(environmentCatalog.catalogValueAtom).entries.keys(),
  ),
).pipe(Atom.withLabel("web-theme-environment-id"));

export function startHostEnvironmentLookup() {
  void window.desktopBridge
    ?.getHostEnvironmentId?.()
    .then((id) => appAtomRegistry.set(hostEnvironmentIdAtom, id))
    .catch(() => undefined);
}
