import { isWorkspaceCatalogPending, type WorkspaceState } from "../../state/workspaceModel";

export const NO_THREADS_DETAIL =
  "Start a thread and an agent gets to work on one of your machines.";

export interface HomeEmptyState {
  readonly title: string;
  readonly detail: string;
  readonly loading: boolean;
  readonly showsAddEnvironment: boolean;
}

export function deriveHomeEmptyState(
  catalogState: WorkspaceState,
  projectCount: number,
): HomeEmptyState {
  const emptyState = deriveEmptyState(catalogState, projectCount);
  return {
    ...emptyState,
    showsAddEnvironment: !emptyState.loading && !catalogState.hasReadyEnvironment,
  };
}

function deriveEmptyState(
  catalogState: WorkspaceState,
  projectCount: number,
): Omit<HomeEmptyState, "showsAddEnvironment"> {
  if (catalogState.isLoadingConnections) {
    return {
      title: "Loading environments",
      detail: "Checking saved environments on this device.",
      loading: true,
    };
  }

  if (!catalogState.hasConnections) {
    return {
      title: "Connect your hub",
      detail: "Scan the QR code your hub shows to see its sessions here.",
      loading: false,
    };
  }

  if (
    (catalogState.connectionState === "available" ||
      catalogState.connectionState === "offline" ||
      catalogState.connectionState === "error" ||
      catalogState.connectionState === "unsupported") &&
    !catalogState.hasLoadedShellSnapshot
  ) {
    return {
      title:
        catalogState.connectionState === "unsupported"
          ? "Client not supported"
          : "Environment unavailable",
      detail:
        catalogState.connectionError ??
        "The saved environment is offline. Check the URL or start the environment, then retry.",
      loading: false,
    };
  }

  if (isWorkspaceCatalogPending(catalogState)) {
    return {
      title: catalogState.hasReadyEnvironment ? "Loading threads" : "Connecting to environment",
      detail: "Loading projects and threads from the saved environment.",
      loading: true,
    };
  }

  if (projectCount === 0 && catalogState.hasLoadedShellSnapshot) {
    return {
      title: "No projects found",
      detail: "The connected environment did not report any projects.",
      loading: false,
    };
  }

  return {
    title: "No threads yet",
    detail: NO_THREADS_DETAIL,
    loading: false,
  };
}
