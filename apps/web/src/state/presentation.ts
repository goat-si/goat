import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentConnectionPhase,
  EnvironmentPresentation,
} from "@goat/client-runtime/connection";
import {
  createEnvironmentPresentationAtoms,
  createEnvironmentSummaryAtoms,
} from "@goat/client-runtime/state/presentation";
import type { EnvironmentId } from "@goat/contracts";
import { Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { serverEnvironment } from "./server";

export const environmentPresentations = createEnvironmentPresentationAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  stateAtom: environmentCatalog.stateAtom,
  serverConfigValueAtom: serverEnvironment.configValueAtom,
});

export const environmentSummaries = createEnvironmentSummaryAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  presentationAtom: environmentPresentations.presentationAtom,
});

const EMPTY_ENVIRONMENT_PRESENTATION_ATOM = Atom.make<EnvironmentPresentation | null>(null).pipe(
  Atom.withLabel("web-environment-presentation:empty"),
);

// Only the phase, so a list row repaints when the phase changes, not on every
// step of a connection attempt.
const environmentConnectionPhaseAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get): EnvironmentConnectionPhase | null =>
      get(environmentPresentations.presentationAtom(environmentId))?.connection.phase ?? null,
  ).pipe(Atom.withLabel(`web-environment-connection-phase:${environmentId}`)),
);

export function useEnvironmentConnectionPhase(
  environmentId: EnvironmentId,
): EnvironmentConnectionPhase | null {
  return useAtomValue(environmentConnectionPhaseAtom(environmentId));
}

export function useEnvironmentPresentation(environmentId: EnvironmentId | null) {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const presentation = useAtomValue(
    environmentId === null
      ? EMPTY_ENVIRONMENT_PRESENTATION_ATOM
      : environmentPresentations.presentationAtom(environmentId),
  );
  return {
    isReady: catalog.isReady,
    presentation,
  };
}
