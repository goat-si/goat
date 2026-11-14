import type { ProjectFaviconTarget } from "@goat/client-runtime/project-favicon-cache";
import {
  createAssetEnvironmentAtoms,
  createProjectFaviconUrlAtomFamily,
  projectFaviconResource,
} from "@goat/client-runtime/state/assets";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { projectFaviconCache } from "../assets/projectFaviconCache";
import { isElectron } from "../env";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { environmentProjectClonesAtom } from "./projectClones";
import { environmentSession } from "./session";
import { environmentProjects } from "./projects";
import { environmentThreadShells } from "./threads";

const localMediaEnvironment = Atom.make((get) => {
  if (!isElectron) return null;
  const environmentId = get(primaryEnvironmentIdAtom);
  if (environmentId === null) return null;
  const connection = get(environmentSession.preparedConnectionValueAtom(environmentId));
  const config = get(environmentSession.initialConfigValueAtom(environmentId));
  return connection._tag === "None" || config === null
    ? null
    : { environmentId, httpBaseUrl: connection.value.httpBaseUrl };
});

export const assetEnvironment = createAssetEnvironmentAtoms(
  connectionAtomRuntime,
  localMediaEnvironment,
  (environmentId, threadId) =>
    Atom.make((get) => {
      // Resolve against the thread's remote checkout, including its worktree when present.
      const thread = get(environmentThreadShells.threadShellAtom({ environmentId, threadId }));
      if (thread === null) return null;
      return (
        thread.worktreePath ??
        get(environmentProjects.projectAtom({ environmentId, projectId: thread.projectId }))
          ?.workspaceRoot ??
        null
      );
    }),
);

export const projectFaviconUrlAtom = createProjectFaviconUrlAtomFamily({
  imageCache: projectFaviconCache,
  createUrl: assetEnvironment.createUrl,
  preparedConnection: environmentSession.preparedConnectionValueAtom,
  projectClones: environmentProjectClonesAtom,
});

/**
 * Asks the server for a project's icon again. Choosing the icon path a project had before would
 * otherwise reuse that path's cached URL, which says "missing" if the file did not exist then.
 */
export function refreshProjectFaviconUrl(target: ProjectFaviconTarget) {
  appAtomRegistry.refresh(
    assetEnvironment.createUrl({
      environmentId: target.environmentId,
      input: { resource: projectFaviconResource(target.cwd, target.faviconPath) },
    }),
  );
}
