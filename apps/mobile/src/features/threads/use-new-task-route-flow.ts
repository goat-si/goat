import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentProject } from "@goat/client-runtime/state/shell";
import { appAtomRegistry } from "../../state/atom-registry";
import {
  composerDraftsLoadedAtom,
  getComposerDraftSnapshot,
  useComposerDraft,
} from "../../state/use-composer-drafts";
import { useEnvironmentShellReadiness } from "../../state/shell";
import { useConnectionsReady, useWorkspaceEnvironments } from "../../state/workspace";
import {
  INACTIVE_FLOW_KEY,
  newTaskFlowStateAtom,
  readNewTaskFlowState,
  resolveRouteDraft,
  stampedEnvironmentProjectsLoading,
  updateNewTaskFlowState,
  type NewTaskFlowState,
} from "./new-task-flow-state";

export function useNewTaskRouteFlow(
  props: { flowKey?: string; routeDraftId?: string },
  projects: ReadonlyArray<EnvironmentProject>,
) {
  const flowKey = props.flowKey ?? INACTIVE_FLOW_KEY;
  const stored = useAtomValue(newTaskFlowStateAtom(flowKey));
  const loaded = useAtomValue(composerDraftsLoadedAtom);
  const routeDraft = useComposerDraft(
    stored.draftKey === null ? (props.routeDraftId ?? null) : null,
  );
  const stampedId = routeDraft.project?.environmentId ?? null;
  const connectionsReady = useConnectionsReady();
  const connection = useWorkspaceEnvironments().find(
    (environment) => environment.environmentId === stampedId,
  );
  const shell = useEnvironmentShellReadiness(stampedId);
  const stampedEnvironmentLoading = stampedEnvironmentProjectsLoading({
    connectionsReady,
    connectionState: connection?.connectionState ?? null,
    shellCacheRead: shell.cacheRead,
    shellStatus: shell.status,
    shellHasError: shell.hasError,
  });
  const resolve = (
    flow: NewTaskFlowState,
    draftsLoaded: boolean,
    stamp: Parameters<typeof resolveRouteDraft>[0]["stamp"],
  ) =>
    resolveRouteDraft({
      flow,
      routeDraftId: props.routeDraftId,
      draftsLoaded,
      stamp,
      projects,
      stampedEnvironmentLoading,
    });
  const resolution = resolve(stored, loaded, routeDraft.project);
  const state = resolution.kind === "open" ? resolution.flow : stored;
  const read = () => {
    const stored = readNewTaskFlowState(flowKey);
    const resolution = resolve(
      stored,
      appAtomRegistry.get(composerDraftsLoadedAtom),
      props.routeDraftId === undefined
        ? undefined
        : getComposerDraftSnapshot(props.routeDraftId).project,
    );
    return resolution.kind === "open" ? resolution.flow : stored;
  };
  const update = (patch: Partial<NewTaskFlowState>) =>
    updateNewTaskFlowState(flowKey, { ...read(), ...patch });
  return {
    flowKey,
    state,
    read,
    update,
    pending: resolution.kind === "pending",
    missingRouteDraftId: resolution.kind === "missing" ? (props.routeDraftId ?? null) : null,
  };
}
