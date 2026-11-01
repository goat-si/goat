import { scopeProjectRef } from "@goat/client-runtime/environment";
import type { EnvironmentProject, EnvironmentThreadShell } from "@goat/client-runtime/state/models";
import type { EnvironmentId, ModelSelection, ProjectId, ScopedProjectRef } from "@goat/contracts";
import type { ProjectSettingSource } from "@goat/shared/projectSettings";
import type { ComposerThreadDraftState, DraftThreadEnvMode } from "../composerDraftStore";

type ComposerModelSelectionState = Pick<
  ComposerThreadDraftState,
  "activeProvider" | "modelSelectionByProvider" | "modelSelectionExplicit"
>;

interface ThreadContextLike {
  environmentId: EnvironmentId;
  projectId: ProjectId;
}

interface NewThreadHandler {
  (
    projectRef: ScopedProjectRef,
    options?: {
      branch?: string | null;
      worktreePath?: string | null;
      envMode?: DraftThreadEnvMode;
      lastWorkEnvMode?: DraftThreadEnvMode;
      startFromOrigin?: boolean;
    },
  ): Promise<unknown>;
}

export interface ChatThreadActionContext {
  readonly activeDraftThread: ThreadContextLike | null;
  readonly activeThread: ThreadContextLike | undefined;
  readonly defaultProjectRef: ScopedProjectRef | null;
  readonly handleNewThread: NewThreadHandler;
}

type LastWorkThread = Pick<
  EnvironmentThreadShell,
  | "environmentId"
  | "projectId"
  | "archivedAt"
  | "latestUserAuthoredMessageAt"
  | "latestUserMessageAt"
  | "worktreePath"
>;
type LastWorkProject = Pick<EnvironmentProject, "environmentId" | "id">;

export function resolveLastWorkTarget(
  threads: ReadonlyArray<LastWorkThread>,
  projects: ReadonlyArray<LastWorkProject>,
): { projectRef: ScopedProjectRef; envMode: DraftThreadEnvMode } | null {
  const loadedProjects = new Set(
    projects.map((project) => `${project.environmentId}:${project.id}`),
  );
  let latestThread: LastWorkThread | null = null;
  let latestAt = -Infinity;
  for (const thread of threads) {
    if (
      thread.archivedAt !== null ||
      !loadedProjects.has(`${thread.environmentId}:${thread.projectId}`)
    ) {
      continue;
    }
    const authoredAt = thread.latestUserAuthoredMessageAt ?? null;
    const timestamp =
      thread.latestUserAuthoredMessageAt === undefined ? thread.latestUserMessageAt : authoredAt;
    if (timestamp === null) continue;
    const at = Date.parse(timestamp);
    if (at > latestAt) {
      latestThread = thread;
      latestAt = at;
    }
  }
  return latestThread === null
    ? null
    : {
        projectRef: scopeProjectRef(latestThread.environmentId, latestThread.projectId),
        envMode: latestThread.worktreePath != null ? "worktree" : "local",
      };
}

export function resolveNewThreadEnvModeWithLastWork(input: {
  resolvedSource: ProjectSettingSource;
  resolvedMode: DraftThreadEnvMode;
  lastWorkEnvMode: DraftThreadEnvMode | undefined;
}): DraftThreadEnvMode {
  return input.lastWorkEnvMode !== undefined && input.resolvedSource === "environment"
    ? input.lastWorkEnvMode
    : input.resolvedMode;
}

export async function startNewThreadFromLastWork(input: {
  threads: ReadonlyArray<LastWorkThread>;
  projects: ReadonlyArray<LastWorkProject>;
  handleNewThread: NewThreadHandler;
}): Promise<boolean> {
  const target = resolveLastWorkTarget(input.threads, input.projects);
  if (target === null) return false;
  await input.handleNewThread(target.projectRef, { lastWorkEnvMode: target.envMode });
  return true;
}

export function resolveNewDraftStartFromOrigin(input: {
  envMode: DraftThreadEnvMode;
  newWorktreesStartFromOrigin: boolean;
}): boolean {
  return input.envMode === "worktree" && input.newWorktreesStartFromOrigin;
}

export function resolveNewThreadModelSelectionOverride(input: {
  readonly projectDefaultSelection: ModelSelection | null;
  readonly carrySelection: ModelSelection | null;
  readonly carrySourceDraftId: string | null;
  readonly destinationDraftId: string;
}): ModelSelection | null {
  return (
    input.projectDefaultSelection ??
    (input.carrySourceDraftId === input.destinationDraftId ? null : input.carrySelection)
  );
}

export function hasExplicitComposerModelSelection(
  draft: ComposerModelSelectionState | null | undefined,
): boolean {
  const activeProvider = draft?.activeProvider;
  return (
    draft?.modelSelectionExplicit === true &&
    activeProvider !== null &&
    activeProvider !== undefined &&
    draft.modelSelectionByProvider[activeProvider] !== undefined
  );
}

export function resolveThreadActionProjectRef(
  context: ChatThreadActionContext,
): ScopedProjectRef | null {
  if (context.activeThread) {
    return scopeProjectRef(context.activeThread.environmentId, context.activeThread.projectId);
  }
  if (context.activeDraftThread) {
    return scopeProjectRef(
      context.activeDraftThread.environmentId,
      context.activeDraftThread.projectId,
    );
  }
  return context.defaultProjectRef;
}

export async function startNewThreadFromContext(
  context: ChatThreadActionContext,
): Promise<boolean> {
  const projectRef = resolveThreadActionProjectRef(context);
  if (!projectRef) {
    return false;
  }

  await context.handleNewThread(projectRef);
  return true;
}
