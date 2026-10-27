import { EnvironmentId } from "@goat/contracts";
import { useNewTaskEnvironmentLoading } from "./use-new-task-environment-loading";
import { useEffect, useRef } from "react";
import { CommonActions, useIsFocused, useNavigation } from "@react-navigation/native";
import type { EnvironmentProject } from "@goat/client-runtime/state/shell";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { updateComposerDraftSettings } from "../../state/use-composer-drafts";
import { useWorkspaceBackNavigation } from "../workspace/useAndroidWorkspaceNavigation";
import { resolveDraftProjectSelection } from "./new-task-project-selection";
import type { useNewTaskFlow } from "./new-task-flow-provider";
import type { NewTaskDraftScreen } from "./NewTaskDraftScreen";
import type { ComponentProps } from "react";

export function useInitialNewTaskProject(
  props: ComponentProps<typeof NewTaskDraftScreen> & {
    readonly flow: ReturnType<typeof useNewTaskFlow>;
    readonly servesRoute: boolean;
    readonly projects: ReadonlyArray<EnvironmentProject>;
    readonly onMissingProject: (missing: boolean) => void;
  },
) {
  const { flow, servesRoute, projects } = props;
  const { projectScopes, selectedProject, selectedProjectKey, setProject } = flow;
  const navigation = useNavigation();
  const isFocused = useIsFocused();
  const goBack = useWorkspaceBackNavigation("threads");
  const environments = useWorkspaceEnvironments();
  const environmentLoading = useNewTaskEnvironmentLoading(
    props.initialProjectRef?.environmentId
      ? EnvironmentId.make(props.initialProjectRef.environmentId)
      : null,
  );
  const appliedInitialProjectKeyRef = useRef<string | null>(null);
  const initialPickerRef = useRef<"opening" | "open" | "dismissed" | null>(null);
  const lastInitialProjectRefRef = useRef(props.initialProjectRef);

  // oxlint-disable-next-line goat/react-effect-budget -- Applies route selection and coordinates the initial project picker.
  useEffect(() => {
    if (!servesRoute || props.pendingTaskId || props.draftId) {
      return;
    }
    if (lastInitialProjectRefRef.current !== props.initialProjectRef) {
      lastInitialProjectRefRef.current = props.initialProjectRef;
      appliedInitialProjectKeyRef.current = null;
    }
    const initialEnvironmentId = props.initialProjectRef?.environmentId;
    const initialProjectId = props.initialProjectRef?.projectId;
    if (initialEnvironmentId && initialProjectId) {
      const directProject =
        projects.find(
          (project) =>
            project.environmentId === initialEnvironmentId && project.id === initialProjectId,
        ) ?? null;

      if (directProject) {
        // Apply the route project once or picker changes would immediately revert.
        const directProjectKey = `${directProject.environmentId}:${directProject.id}`;
        if (appliedInitialProjectKeyRef.current === directProjectKey) {
          return;
        }
        if (props.initialProjectRef?.branch) {
          if (
            selectedProject?.environmentId !== directProject.environmentId ||
            selectedProject.id !== directProject.id
          ) {
            setProject(directProject);
            return;
          }
          if (!flow.draftKey) return;
          // Checkout completed before mount; local mode reuses it while worktree mode would create another.
          updateComposerDraftSettings(flow.draftKey, {
            workspaceSelection: {
              mode: "local",
              branch: props.initialProjectRef.branch,
              worktreePath: props.initialProjectRef.worktreePath ?? null,
              startFromOrigin: false,
            },
          });
        }
        appliedInitialProjectKeyRef.current = directProjectKey;
        if (
          selectedProject?.environmentId === directProject.environmentId &&
          selectedProject.id === directProject.id
        ) {
          return;
        }
        setProject(directProject);
        return;
      }

      if (!environmentLoading) {
        // oxlint-disable-next-line react/set-state-in-effect -- Route-driven project resolution starts the return-to-picker flow when no project matches.
        props.onMissingProject(true);
      }
      return;
    }

    if (initialPickerRef.current === "opening" && !isFocused) initialPickerRef.current = "open";
    const selection = resolveDraftProjectSelection(selectedProjectKey, projects, projectScopes, {
      incomingShareId: props.incomingShareId,
      pickerClosed: initialPickerRef.current === "open" && isFocused,
      connectedEnvironmentIds: new Set(
        environments
          .filter((environment) => environment.connectionState === "connected")
          .map((environment) => environment.environmentId),
      ),
    });
    if (selection.kind === "preserve") {
      initialPickerRef.current = null;
      return;
    }
    if (selection.kind === "select") {
      setProject(selection.project);
      return;
    }

    if (selection.kind === "dismiss") {
      initialPickerRef.current = "dismissed";
      goBack();
      return;
    }
    if (initialPickerRef.current !== null) return;
    initialPickerRef.current = "opening";
    navigation.dispatch(
      CommonActions.navigate("NewTaskProject", { incomingShareId: props.incomingShareId }),
    );
  }, [
    servesRoute,
    isFocused,
    goBack,
    environments,
    environmentLoading,
    props.onMissingProject,
    projectScopes,
    projects,
    flow.draftKey,
    props.initialProjectRef,
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Opening a draft from a share, pending task, or draft id re-resolves its project.
    props.incomingShareId,
    props.pendingTaskId,
    props.draftId,
    navigation,
    selectedProject,
    selectedProjectKey,
    setProject,
  ]);
}
