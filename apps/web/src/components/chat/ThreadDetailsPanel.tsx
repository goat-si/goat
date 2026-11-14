import { scopeProjectRef } from "@goat/client-runtime/environment";
import { isScratchProject } from "@goat/client-runtime/state/projects";
import { useProject, useQuietThreadShell, useServerConfigs } from "../../state/entities";
import { ThreadDetailsThreadPrRows, threadShellHasPullRequest } from "./ThreadDetailsThreadPrRows";
import type {
  EditorId,
  EnvironmentId,
  ProjectId,
  ProjectScript,
  ResolvedKeybindingsConfig,
  ThreadId,
} from "@goat/contracts";

import { deriveCloudTaskState } from "@goat/client-runtime/state/cloud-task";
import { useAtomValue } from "@effect/atom-react";
import { type DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { useThreadProjection, useThreadShell } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { type EnvMode, type EnvironmentOption } from "../BranchToolbar.logic";
import { BranchToolbar } from "../BranchToolbar";
import BaseGitActionsControl from "../GitActionsControl";
import ProjectScriptsControl, {
  type NewProjectScriptInput,
  type ProjectScriptActionResult,
} from "../ProjectScriptsControl";
import { memo, type ComponentProps } from "react";
import { ThreadDetailsCard } from "./ThreadDetailsCard";
import { ComputerUseHistorySection } from "./ComputerUseHistorySection";
import { OpenInPicker } from "./OpenInPicker";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { ThreadAutomationsPanel } from "./ThreadAutomationsPanel";
import { ThreadRelationshipsPanel } from "./ThreadRelationshipsControl";
import type { MachineWithoutProject } from "../../lib/runOnArrival";

const GitActionsControl = memo(BaseGitActionsControl);

export interface ThreadDetailsPanelProps
  extends
    Pick<ComponentProps<typeof ThreadDetailsCard>, "anchor" | "handle" | "onPresentationChange">,
    Pick<
      ComponentProps<typeof BranchToolbar>,
      "sshDestination" | "sshOptions" | "sshDisabledReason" | "onSshDestinationChange"
    > {
  forceNewWorktree?: boolean;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  projectId: ProjectId;
  worktreePath: string | null;
  isServerThread: boolean;
  draftId?: DraftId;
  activeProjectName: string | undefined;
  activeProjectScripts: ReadonlyArray<ProjectScript> | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  showOpenInPicker: boolean;
  openInShortcutEnabled: boolean;
  gitCwd: string | null;
  isGitRepo: boolean;
  envLocked: boolean;
  availableEnvironments: readonly EnvironmentOption[];
  environmentsWithoutProject: readonly MachineWithoutProject[];
  autoEnvironmentLabel?: string | undefined;
  onAutoEnvironment?: (() => void) | undefined;
  onEnvironmentChange?: (environmentId: EnvironmentId) => void;
  onEnvModeChange: (mode: EnvMode) => void;
  envMode: EnvMode;
  activeThreadBranchOverride?: string | null;
  onActiveThreadBranchOverrideChange?: (branch: string | null) => void;
  startFromOrigin: boolean;
  onStartFromOriginChange: (startFromOrigin: boolean) => void;
  onCheckoutPullRequestRequest?: (reference: string) => void;
  onComposerFocusRequest: () => void;
  onOpenChanges?: () => void;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<ProjectScriptActionResult>;
  onUpdateProjectScript: (
    scriptId: string,
    input: NewProjectScriptInput,
  ) => Promise<ProjectScriptActionResult>;
  onDeleteProjectScript: (scriptId: string) => Promise<ProjectScriptActionResult>;
}

export function ThreadDetailsPanel(props: ThreadDetailsPanelProps) {
  const activeThreadRef = { environmentId: props.environmentId, threadId: props.threadId };
  const project = useProject(scopeProjectRef(props.environmentId, props.projectId));
  const config = useServerConfigs().get(props.environmentId);
  const offersGit =
    props.gitCwd !== null &&
    config !== undefined &&
    project !== null &&
    !isScratchProject(project, config.scratchWorkspaceRoot);
  const thread = useThreadShell(props.draftId ? null : activeThreadRef);
  const hasPullRequest = threadShellHasPullRequest(
    useQuietThreadShell(props.draftId ? null : activeThreadRef),
  );
  const projection = useThreadProjection(props.draftId ? null : activeThreadRef)?.projection;
  const selectedInstanceId = useComposerDraftStore(
    (store) =>
      store.getComposerDraft(props.draftId ?? activeThreadRef)?.activeProvider ??
      projection?.thread.providerInstanceId ??
      thread?.providerInstanceId,
  );
  const selectedProvider = useAtomValue(
    serverEnvironment.providersValueAtom(props.environmentId),
  )?.find((provider) => provider.instanceId === selectedInstanceId);
  const { showLocalWorkspace } = deriveCloudTaskState(projection, selectedProvider);
  const branchToolbarProps = {
    showGitControls: props.isGitRepo,
    sshDestination: props.sshDestination,
    sshOptions: props.sshOptions,
    sshDisabledReason: props.sshDisabledReason,
    onSshDestinationChange: props.onSshDestinationChange,
    environmentId: props.environmentId,
    threadId: props.threadId,
    projectId: props.projectId,
    worktreePath: props.worktreePath,
    isServerThread: props.isServerThread,
    ...(props.draftId ? { draftId: props.draftId } : {}),
    onEnvModeChange: props.onEnvModeChange,
    startFromOrigin: props.startFromOrigin,
    onStartFromOriginChange: props.onStartFromOriginChange,
    envMode: props.envMode,
    ...(props.activeThreadBranchOverride !== undefined
      ? { activeThreadBranchOverride: props.activeThreadBranchOverride }
      : {}),
    ...(props.onActiveThreadBranchOverrideChange
      ? { onActiveThreadBranchOverrideChange: props.onActiveThreadBranchOverrideChange }
      : {}),
    envLocked: props.envLocked,
    forceNewWorktree: props.forceNewWorktree ?? false,
    onComposerFocusRequest: props.onComposerFocusRequest,
    ...(props.onCheckoutPullRequestRequest
      ? { onCheckoutPullRequestRequest: props.onCheckoutPullRequestRequest }
      : {}),
  };

  return (
    <ThreadDetailsCard
      threadRef={{ environmentId: props.environmentId, threadId: props.threadId }}
      anchor={props.anchor}
      handle={props.handle}
      onPresentationChange={props.onPresentationChange}
    >
      {(density) => (
        <>
          <ThreadDetailsSection
            headingId="thread-details-workspace-heading"
            title="Workspace"
            separated={false}
            showHeading={false}
          >
            <div className="flex flex-col">
              {density === "full" && showLocalWorkspace ? (
                <BranchToolbar
                  layout="panel"
                  panelSection="workspace"
                  availableEnvironments={props.availableEnvironments}
                  environmentsWithoutProject={props.environmentsWithoutProject}
                  {...(props.onEnvironmentChange
                    ? { onEnvironmentChange: props.onEnvironmentChange }
                    : {})}
                  autoEnvironmentLabel={props.autoEnvironmentLabel}
                  onAutoEnvironment={props.onAutoEnvironment}
                  {...branchToolbarProps}
                />
              ) : null}

              {density !== "essential" && props.showOpenInPicker ? (
                <OpenInPicker
                  keybindings={props.keybindings}
                  environmentId={props.environmentId}
                  availableEditors={props.availableEditors}
                  openInCwd={props.gitCwd}
                  enableShortcut={props.openInShortcutEnabled}
                  displayMode="panel"
                />
              ) : null}

              {props.activeProjectScripts ? (
                <ProjectScriptsControl
                  environmentId={props.environmentId}
                  displayMode="panel"
                  scripts={props.activeProjectScripts}
                  preferredScriptId={props.preferredScriptId}
                  onRunScript={props.onRunProjectScript}
                  onAddScript={props.onAddProjectScript}
                  onUpdateScript={props.onUpdateProjectScript}
                  onDeleteScript={props.onDeleteProjectScript}
                />
              ) : null}
            </div>
          </ThreadDetailsSection>

          {showLocalWorkspace && (offersGit || hasPullRequest) ? (
            <ThreadDetailsSection
              headingId="thread-details-version-control-heading"
              title="Version Control"
              showHeading={false}
              separated={density === "full"}
            >
              <div className="flex flex-col">
                {offersGit && props.isGitRepo ? (
                  <BranchToolbar layout="panel" panelSection="branch" {...branchToolbarProps} />
                ) : null}
                {!offersGit || !props.isGitRepo ? (
                  <ThreadDetailsThreadPrRows
                    threadRef={activeThreadRef}
                    project={project}
                    composerTarget={props.draftId ?? activeThreadRef}
                  />
                ) : null}
                {offersGit && props.gitCwd && props.activeProjectName ? (
                  <GitActionsControl
                    displayMode="panel"
                    compact={density !== "full"}
                    gitCwd={props.gitCwd}
                    activeThreadRef={activeThreadRef}
                    {...(props.draftId ? { draftId: props.draftId } : {})}
                    {...(props.onOpenChanges ? { onOpenChanges: props.onOpenChanges } : {})}
                  />
                ) : null}
              </div>
            </ThreadDetailsSection>
          ) : null}

          {!props.draftId ? (
            <ComputerUseHistorySection
              environmentId={props.environmentId}
              threadId={props.threadId}
              hideWithoutPermission
            />
          ) : null}

          {density === "full" && !props.draftId ? (
            <ThreadAutomationsPanel environmentId={props.environmentId} threadId={props.threadId} />
          ) : null}

          {density === "full" && !props.draftId ? (
            <ThreadRelationshipsPanel
              environmentId={props.environmentId}
              threadId={props.threadId}
            />
          ) : null}
        </>
      )}
    </ThreadDetailsCard>
  );
}
