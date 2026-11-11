import { AVAILABLE_CONNECTION_STATE } from "@goat/client-runtime/connection";
import { parseScopedProjectKey } from "@goat/client-runtime/environment";
import { createEnvironmentProjectAtoms } from "@goat/client-runtime/state/projects";
import { createProjectEnvironmentAtoms } from "@goat/client-runtime/state/projects";
import { createEnvironmentRpcQueryAtomFamily } from "@goat/client-runtime/state/runtime";
import { WS_METHODS } from "@goat/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { serverEnvironment } from "./server";
import { environmentShell, environmentSnapshotAtom, requiresPrimaryEnvironment } from "./shell";

export const environmentProjects = createEnvironmentProjectAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: environmentSnapshotAtom,
  serverConfigValueAtom: serverEnvironment.configValueAtom,
});
export const projectEnvironment = createProjectEnvironmentAtoms(connectionAtomRuntime, {
  projectAtom: environmentProjects.projectAtom,
});
export const projectContentSearch = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:projects:search-contents",
  tag: WS_METHODS.projectsSearchContents,
  staleTimeMs: 5_000,
  idleTtlMs: 60_000,
});

export const defaultProjectFallbackReadyAtom = Atom.family((projectKey: string | null) =>
  Atom.make((get) => {
    const remembered = projectKey === null ? null : parseScopedProjectKey(projectKey);
    if (!remembered) return true;
    const catalog = get(environmentCatalog.catalogValueAtom);
    if (!catalog.isReady) return false;
    if (
      requiresPrimaryEnvironment() &&
      !Array.from(catalog.entries.values()).some(
        (entry) => entry.target._tag === "PrimaryConnectionTarget",
      )
    )
      return false;
    const entry = catalog.entries.get(remembered.environmentId);
    if (!entry?.enabled || entry.unsupportedReason !== undefined) return true;
    if (get(environmentShell.statusAtom(remembered.environmentId)) === "live") return true;
    const connection = AsyncResult.getOrElse(
      get(environmentCatalog.stateAtom(remembered.environmentId)),
      () => AVAILABLE_CONNECTION_STATE,
    );
    return (
      connection.phase === "offline" ||
      connection.phase === "blocked" ||
      (connection.phase === "backoff" && connection.attempt > 2)
    );
  }).pipe(Atom.withLabel(`web-default-project-fallback-ready:${projectKey}`)),
);
