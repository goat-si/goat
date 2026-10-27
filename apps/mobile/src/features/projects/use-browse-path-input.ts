import {
  getAddProjectInitialQuery,
  getCloneDestinationBrowsePath,
  getCloneDestinationPath,
} from "@goat/client-runtime/operations/projects";
import {
  canPreloadBrowsePath,
  createBrowseNavigationCoordinator,
} from "@goat/client-runtime/state/filesystem";
import { appendBrowsePathSegment, isWindowsPlatform } from "@goat/client-runtime/state/projects";
import { AuthFilesystemReadScope, type EnvironmentId } from "@goat/contracts";
import { useEffect, useState } from "react";

import { filesystemEnvironment } from "../../state/filesystem";
import { readEnvironmentScope } from "../../state/session";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { useRemoteEnvironmentRuntime } from "../../state/use-remote-environment-registry";

export function useBrowsePathInput(
  environment: {
    readonly environmentId: EnvironmentId;
    readonly baseDirectory: string | null;
    readonly platform: string;
  } | null,
  pinnedDirectoryName = "",
) {
  const environmentId = environment?.environmentId ?? null;
  const environmentBaseDirectory = environment?.baseDirectory ?? null;
  const clonePathCaseSensitive = !isWindowsPlatform(environment?.platform ?? "");
  const seedPath = getCloneDestinationPath(
    getAddProjectInitialQuery(environmentBaseDirectory),
    pinnedDirectoryName,
  );
  // Each host keeps the path last typed or browsed for it, and shows its own default until then,
  // so switching hosts and back loses nothing. With no host selected (one dropping out briefly),
  // the field keeps the last path typed anywhere.
  const [paths, setPaths] = useState<{
    readonly byHost: ReadonlyMap<EnvironmentId, string>;
    readonly last: string;
  }>(() => ({ byHost: new Map(), last: seedPath }));
  const pathInput =
    environmentId === null ? paths.last : (paths.byHost.get(environmentId) ?? seedPath);
  const commitPathInput = (path: string) =>
    setPaths((current) => {
      const byHost = new Map(current.byHost);
      if (environmentId !== null) {
        byHost.set(environmentId, path);
      }
      return { byHost, last: path };
    });
  const environmentRuntime = useRemoteEnvironmentRuntime(environmentId);
  const loadBrowsePath = useAtomQueryRunner(filesystemEnvironment.browse, {
    reportFailure: false,
    reportDefect: false,
  });
  const [browseNavigation] = useState(createBrowseNavigationCoordinator);
  const [navigatingEnvironmentId, setNavigatingEnvironmentId] = useState<
    EnvironmentId | null | undefined
  >(undefined);
  const isBrowseNavigating = navigatingEnvironmentId === environmentId;
  const setPathInput = (path: string) => {
    browseNavigation.invalidate();
    setNavigatingEnvironmentId(undefined);
    commitPathInput(path);
  };
  const navigateToBrowsePath = async (input: {
    readonly browseDirectoryPath: string;
    readonly selectedDirectoryName?: string;
  }) => {
    const selectedDirectoryPath = input.selectedDirectoryName
      ? appendBrowsePathSegment(input.browseDirectoryPath, input.selectedDirectoryName)
      : input.browseDirectoryPath;
    const nextPathInput =
      pinnedDirectoryName && input.selectedDirectoryName
        ? getCloneDestinationBrowsePath({
            browseDirectoryPath: input.browseDirectoryPath,
            selectedDirectoryName: input.selectedDirectoryName,
            cloneDirectoryName: pinnedDirectoryName,
            caseSensitive: clonePathCaseSensitive,
          })
        : getCloneDestinationPath(selectedDirectoryPath, pinnedDirectoryName);
    setNavigatingEnvironmentId(environmentId);
    const committed = await browseNavigation.run(
      async () => {
        if (
          environment &&
          readEnvironmentScope(environment.environmentId, AuthFilesystemReadScope) &&
          canPreloadBrowsePath(environmentRuntime?.connectionState)
        ) {
          await loadBrowsePath({
            environmentId: environment.environmentId,
            input: { partialPath: selectedDirectoryPath },
          });
        }
      },
      () => commitPathInput(nextPathInput),
    );
    if (committed) {
      setNavigatingEnvironmentId(undefined);
    }
    return committed;
  };

  // oxlint-disable-next-line goat/react-effect-budget -- invalidates pending browse work on unmount
  useEffect(
    () => () => {
      browseNavigation.invalidate();
    },
    [browseNavigation],
  );

  return { isBrowseNavigating, pathInput, setPathInput, navigateToBrowsePath };
}
