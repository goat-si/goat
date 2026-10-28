import { Atom } from "effect/reactivity";
import { useEffect } from "react";

import { environmentCatalog } from "../../connection/catalog";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentThreadShells, threadFamilies } from "../../state/threads";
import { createRemoteLauncherFamilies } from "./remoteLauncherFamilies";

const readyGenerationAtom = Atom.family((id: Parameters<typeof threadFamilies.generationAtom>[0]) =>
  Atom.make((get) =>
    get(threadFamilies.readinessAtom(id)) === null ? 0 : get(threadFamilies.generationAtom(id)),
  ),
);
const remoteFamilies = createRemoteLauncherFamilies({
  threadsAtom: environmentThreadShells.quietThreadShellsAtom,
  catalogAtom: environmentCatalog.catalogValueAtom,
  readyGenerationAtom,
  familyAtom: threadFamilies.familyAtom,
  mount: threadFamilies.mount,
});

export function RemoteLauncherReads() {
  // oxlint-disable-next-line goat/react-effect-budget -- Retain remote launcher reads while the sidebar owns the external registry.
  useEffect(() => remoteFamilies.retain(appAtomRegistry), []);
  return null;
}
