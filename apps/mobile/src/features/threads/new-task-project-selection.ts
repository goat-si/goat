import type { EnvironmentProject } from "@goat/client-runtime/state/shell";
import { repositoryGroupingKeyOf, type EnvironmentId } from "@goat/contracts";
import { fileBasename } from "@goat/shared/path";

import { scopedProjectKey } from "../../lib/scopedEntities";
import type { HomeProjectScope } from "../home/homeThreadList";

type DraftProjectSelectionResolution =
  | { readonly kind: "preserve" }
  | { readonly kind: "select"; readonly project: EnvironmentProject }
  | { readonly kind: "pick" }
  | { readonly kind: "dismiss" };

/**
 * The copy of a project a new thread starts in: the preferred environment's, then the
 * representative. A connected copy wins over a disconnected one.
 */
export function getProjectScopeSelectionTarget(
  scope: HomeProjectScope,
  preferredEnvironmentId: EnvironmentId | null,
  connectedEnvironmentIds: ReadonlySet<EnvironmentId>,
): EnvironmentProject {
  const rank = (project: EnvironmentProject) =>
    project.environmentId === preferredEnvironmentId ? 0 : project === scope.representative ? 1 : 2;
  const ordered = [...scope.projects].sort((left, right) => rank(left) - rank(right));
  return (
    ordered.find((project) => connectedEnvironmentIds.has(project.environmentId)) ??
    ordered[0] ??
    scope.representative
  );
}

export function filterProjectScopes(
  scopes: ReadonlyArray<HomeProjectScope>,
  searchText: string,
): ReadonlyArray<HomeProjectScope> {
  const query = searchText.trim().toLowerCase();
  if (!query) return scopes;
  return scopes.filter(
    (scope) =>
      scope.title.toLowerCase().includes(query) ||
      scope.projects.some(
        (project) =>
          project.title.toLowerCase().includes(query) ||
          project.workspaceRoot.toLowerCase().includes(query),
      ),
  );
}

/** A workspace root's folder name on any host OS. Empty placeholder roots and drive roots have none. */
export function workspaceFolderName(workspaceRoot: string): string | null {
  return /^(?:[a-zA-Z]:)?[/\\]*$/.test(workspaceRoot) ? null : fileBasename(workspaceRoot);
}

export function resolveEnvironmentProjectMatch(
  projectsOnTarget: ReadonlyArray<EnvironmentProject>,
  selectedProject: EnvironmentProject | null,
): EnvironmentProject | null {
  const repositoryKey = selectedProject?.repositoryIdentity
    ? repositoryGroupingKeyOf(selectedProject.repositoryIdentity)
    : null;
  const workspaceBasename = selectedProject
    ? workspaceFolderName(selectedProject.workspaceRoot)
    : null;
  // Use weaker signals only when identity is unknown; different known repositories never match by basename or title.
  const isKnownMismatch = (project: EnvironmentProject) => {
    const projectKey = project.repositoryIdentity
      ? repositoryGroupingKeyOf(project.repositoryIdentity)
      : null;
    return repositoryKey !== null && projectKey !== null && projectKey !== repositoryKey;
  };
  return (
    (repositoryKey !== null
      ? projectsOnTarget.find(
          (project) =>
            (project.repositoryIdentity
              ? repositoryGroupingKeyOf(project.repositoryIdentity)
              : null) === repositoryKey,
        )
      : undefined) ??
    (workspaceBasename !== null
      ? projectsOnTarget.find(
          (project) =>
            !isKnownMismatch(project) &&
            workspaceFolderName(project.workspaceRoot) === workspaceBasename,
        )
      : undefined) ??
    (selectedProject !== null
      ? projectsOnTarget.find(
          (project) => !isKnownMismatch(project) && project.title === selectedProject.title,
        )
      : undefined) ??
    projectsOnTarget[0] ??
    null
  );
}

/** Both projects have a known repository identity, and it is the same one. */
export function isSameRepository(
  left: EnvironmentProject | null,
  right: EnvironmentProject | null,
): boolean {
  return (
    left?.repositoryIdentity != null &&
    right?.repositoryIdentity != null &&
    repositoryGroupingKeyOf(left.repositoryIdentity) ===
      repositoryGroupingKeyOf(right.repositoryIdentity)
  );
}

export function resolveDraftProjectSelection(
  selectedProjectKey: string | null,
  projects: ReadonlyArray<EnvironmentProject>,
  projectScopes: ReadonlyArray<HomeProjectScope>,
  draft: {
    readonly incomingShareId?: string;
    readonly pickerClosed: boolean;
    readonly connectedEnvironmentIds: ReadonlySet<EnvironmentId>;
    readonly useLastProject?: boolean | undefined;
    readonly lastProject?: ProjectRef | undefined;
  },
): DraftProjectSelectionResolution {
  const hasExplicitProjectSelection =
    selectedProjectKey !== null &&
    projects.some(
      (project) => scopedProjectKey(project.environmentId, project.id) === selectedProjectKey,
    );
  if (hasExplicitProjectSelection) {
    return { kind: "preserve" };
  }

  if (draft.pickerClosed && selectedProjectKey === null && draft.incomingShareId === undefined) {
    return { kind: "dismiss" };
  }
  const last =
    draft.incomingShareId !== undefined && draft.useLastProject !== false
      ? projects.find(
          (project) =>
            project.environmentId === draft.lastProject?.environmentId &&
            project.id === draft.lastProject.projectId &&
            project.archivedAt == null,
        )
      : undefined;
  if (last) {
    // Prefer the remembered copy, but not over a connected copy of the same project. Match
    // by projectRefs: a stale registration of a path is a ref of its scope, not a member.
    const lastScope = projectScopes.find((scope) =>
      scope.projectRefs.some(
        (ref) => ref.environmentId === last.environmentId && ref.projectId === last.id,
      ),
    );
    const live = lastScope?.projects.filter((project) => project.archivedAt == null) ?? [];
    const project =
      lastScope && live.length > 0
        ? getProjectScopeSelectionTarget(
            { ...lastScope, projects: live },
            last.environmentId,
            draft.connectedEnvironmentIds,
          )
        : last;
    return { kind: "select", project };
  }
  const onlyScope =
    draft.incomingShareId !== undefined && projectScopes.length === 1 ? projectScopes[0] : null;
  return onlyScope
    ? {
        kind: "select",
        project: getProjectScopeSelectionTarget(onlyScope, null, draft.connectedEnvironmentIds),
      }
    : { kind: "pick" };
}

type ProjectRef = { readonly environmentId: string; readonly projectId: string };

export function resolveDraftShareTransfer(options: {
  readonly selectedProjectKey: string | null;
  readonly selectedProject: EnvironmentProject | null;
  readonly initialProjectRef?: {
    readonly environmentId?: string;
    readonly projectId?: string;
  };
  readonly hasPendingShare: boolean;
  readonly awaitingServerConfig: boolean;
  readonly isImportingShare: boolean;
}) {
  const selected = options.selectedProject;
  const initial = options.initialProjectRef;
  const project =
    selected &&
    options.selectedProjectKey === scopedProjectKey(selected.environmentId, selected.id) &&
    (!initial?.environmentId ||
      !initial.projectId ||
      (selected.environmentId === initial.environmentId && selected.id === initial.projectId))
      ? selected
      : null;
  return {
    project,
    // An unreserved share waiting for a destination must leave Back and project selection usable.
    isPending:
      options.isImportingShare ||
      Boolean(project && options.hasPendingShare && !options.awaitingServerConfig),
  };
}

/** The live copy of the thread list's filtered project a new thread starts in: the remembered one if it is a copy. */
export function newTaskFilteredProject(
  scope: HomeProjectScope,
  preferredEnvironmentId: EnvironmentId | null,
  connectedEnvironmentIds: ReadonlySet<EnvironmentId>,
  lastProject: ProjectRef | undefined,
): ProjectRef | undefined {
  const live = scope.projects.filter((project) => project.archivedAt == null);
  if (live.length === 0) return undefined;
  const project =
    live.find(
      (candidate) =>
        candidate.environmentId === lastProject?.environmentId &&
        candidate.id === lastProject.projectId,
    ) ??
    getProjectScopeSelectionTarget(
      { ...scope, projects: live },
      preferredEnvironmentId,
      connectedEnvironmentIds,
    );
  return { environmentId: project.environmentId, projectId: project.id };
}

export function newTaskDestination(options: {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly projectScopes?: ReadonlyArray<HomeProjectScope>;
  readonly connectedEnvironmentIds?: ReadonlySet<EnvironmentId>;
  readonly requestId: string;
  readonly useLastProject: boolean | undefined;
  readonly currentProject: ProjectRef | undefined;
  readonly filteredProject: ProjectRef | undefined;
  readonly lastProject: ProjectRef | undefined;
}) {
  const find = (ref: ProjectRef | undefined) =>
    ref &&
    options.projects.find(
      (project) => project.environmentId === ref.environmentId && project.id === ref.projectId,
    );
  const last = find(options.lastProject);
  const matched =
    options.useLastProject === false
      ? undefined
      : (find(options.currentProject) ??
        find(options.filteredProject) ??
        (last?.archivedAt == null ? last : undefined));
  const scope = matched && options.projectScopes?.find((scope) => scope.projects.includes(matched));
  const project =
    scope && options.connectedEnvironmentIds
      ? getProjectScopeSelectionTarget(
          scope,
          matched?.environmentId ?? null,
          options.connectedEnvironmentIds,
        )
      : matched;
  return project
    ? {
        draft: {
          requestId: options.requestId,
          environmentId: String(project.environmentId),
          projectId: String(project.id),
        },
      }
    : { draft: { requestId: options.requestId } };
}
