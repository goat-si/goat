import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentConnectionPhase,
  EnvironmentPresentation,
} from "@goat/client-runtime/connection";
import { connectionRouteId, connectionRoutes } from "@goat/client-runtime/connection";
import {
  createEnvironmentPresentationAtoms,
  createEnvironmentSummaryAtoms,
  createEnvironmentShellSyncAtom,
} from "@goat/client-runtime/state/presentation";
import type { EnvironmentId } from "@goat/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Option from "effect/Option";

import { environmentCatalog } from "../connection/catalog";
import { serverEnvironment } from "./server";
import { environmentShell } from "./shell";
import { sshRuntime } from "./sshRuntime";

const environmentShellSyncAtom = createEnvironmentShellSyncAtom(environmentShell.stateValueAtom);
const emptyShellSyncAtom = Atom.make(null);

export function useEnvironmentShellSync(environmentId: EnvironmentId | null) {
  return useAtomValue(
    environmentId === null ? emptyShellSyncAtom : environmentShellSyncAtom(environmentId),
  );
}

/** When the shell shown for this environment was captured, if that is known for it. */
export function useEnvironmentSnapshotCapturedAt(environmentId: EnvironmentId | null) {
  return useAtomValue(
    environmentId === null
      ? emptyShellSyncAtom
      : environmentShell.offlineSnapshotAge(environmentId),
  );
}

const sshRuntimeStatusAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    if (window.desktopBridge === undefined) return undefined;
    const entry = get(environmentCatalog.catalogValueAtom).entries.get(environmentId);
    const state = AsyncResult.value(get(environmentCatalog.stateAtom(environmentId)));
    const ready = Option.isSome(state) ? state.value.sshRuntimeReady : undefined;
    if (entry === undefined || ready === undefined) return undefined;
    const route = connectionRoutes(entry).find(
      (candidate) => connectionRouteId(candidate.target) === ready.routeId,
    );
    if (
      route?.target._tag !== "SshConnectionTarget" ||
      Option.isNone(route.profile) ||
      route.profile.value._tag !== "SshConnectionProfile"
    )
      return undefined;
    return get(sshRuntime.statusAtom({ environmentId, target: route.profile.value.target }))
      ?.status;
  }),
);

export const environmentPresentations = createEnvironmentPresentationAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  stateAtom: environmentCatalog.stateAtom,
  serverConfigValueAtom: serverEnvironment.configValueAtom,
  sshRuntimeStatusAtom,
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

const environmentConnectionUnreachableAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get): boolean =>
      get(environmentPresentations.presentationAtom(environmentId))?.connection.unreachable ===
      true,
  ).pipe(Atom.withLabel(`web-environment-connection-unreachable:${environmentId}`)),
);

/** Whether the environment is retrying a host that could not be reached at all. */
export function useEnvironmentConnectionUnreachable(environmentId: EnvironmentId): boolean {
  return useAtomValue(environmentConnectionUnreachableAtom(environmentId));
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
