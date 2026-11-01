import type { DraftSshDestination } from "../composerDraftStore";
import { findSavedSshWorktreeOption, type SavedSshWorktreeOption } from "../lib/sshWorktree";
import { WorkspaceMenuItems } from "./WorkspaceMenuItems";
import { ComposerControl } from "./chat/ComposerControl";
import { ComposerContextLabel } from "./ComposerContextLabel";
import { FolderGitIcon as FolderGit2Icon, FolderGitIcon, FolderIcon } from "~/components/solar";
import { memo, type MouseEvent as ReactMouseEvent } from "react";

import {
  resolveCurrentWorkspaceLabel,
  resolveWorkspaceChipLabel,
  resolveSshWorkspaceLabel,
  type EnvironmentOption,
  type EnvMode,
} from "./BranchToolbar.logic";
import { useComposerMenuProps } from "./chat/composerEventScope";
import { Menu, MenuTrigger, MenuPopup } from "./ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { useAtomValue } from "@effect/atom-react";
import { shortcutLabelForCommand } from "../keybindings";
import { primaryServerKeybindingsAtom } from "../state/server";

const EMPTY_SSH_OPTIONS: ReadonlyArray<SavedSshWorktreeOption> = [];

interface BranchToolbarEnvModeSelectorProps {
  sshDestination?: DraftSshDestination | null | undefined;
  sshOptions?: ReadonlyArray<SavedSshWorktreeOption> | undefined;
  sshDisabledReason?: string | null | undefined;
  onSshDestinationChange?: ((destination: DraftSshDestination) => void) | undefined;

  forceNewWorktree?: boolean;
  envLocked: boolean;
  effectiveEnvMode: EnvMode;
  activeWorktreePath: string | null;
  onEnvModeChange: (mode: EnvMode) => void;
  activeEnvironment?: Pick<EnvironmentOption, "isPrimary" | "label"> | null;
}

export const BranchToolbarEnvModeSelector = memo(function BranchToolbarEnvModeSelector({
  forceNewWorktree = false,
  envLocked,
  effectiveEnvMode,
  activeWorktreePath,
  onEnvModeChange,
  activeEnvironment = null,
  sshDestination = null,
  sshOptions = EMPTY_SSH_OPTIONS,
  sshDisabledReason = null,
  onSshDestinationChange,
}: BranchToolbarEnvModeSelectorProps) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const shortcutLabel = shortcutLabelForCommand(
    useAtomValue(primaryServerKeybindingsAtom),
    "composer.workspace",
  );
  const workspaceLabel = resolveSshWorkspaceLabel({
    sshSelected: sshDestination !== null,
    savedLabel: findSavedSshWorktreeOption(sshOptions, sshDestination)?.label ?? null,
    workspaceLabel: resolveWorkspaceChipLabel({
      forceNewWorktree,
      effectiveEnvMode,
      activeWorktreePath,
      activeEnvironment,
    }),
  });

  const stopContextMenuMouseDown = (event: ReactMouseEvent) => {
    if (event.button !== 0 || event.ctrlKey) {
      event.stopPropagation();
    }
  };

  if (envLocked || forceNewWorktree) {
    const lockedRow = (
      <span
        className="inline-flex h-7 min-w-0 items-center gap-1 border border-transparent px-1.75 font-normal text-muted-foreground/70 text-xs sm:h-6"
        data-composer-context-control
      >
        {activeWorktreePath ? (
          <FolderGitIcon className="size-3" />
        ) : effectiveEnvMode === "worktree" ? (
          <FolderGit2Icon className="size-3" />
        ) : (
          <FolderIcon className="size-3" />
        )}
        <ComposerContextLabel collapseWhenCompact={false}>{workspaceLabel}</ComposerContextLabel>
      </span>
    );

    return (
      <Tooltip>
        <TooltipTrigger render={lockedRow} />
        <TooltipPopup>
          {forceNewWorktree ? "Each model starts in its own worktree." : workspaceLabel}
        </TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={<ComposerControl size="xs" />}
              aria-label="Workspace"
              data-composer-shortcut="composer.workspace"
              data-composer-context-control
              onMouseDownCapture={stopContextMenuMouseDown}
            />
          }
        >
          {effectiveEnvMode === "worktree" ? (
            <FolderGit2Icon className="size-3" />
          ) : activeWorktreePath ? (
            <FolderGitIcon className="size-3" />
          ) : (
            <FolderIcon className="size-3" />
          )}
          <ComposerContextLabel collapseWhenCompact={false}>{workspaceLabel}</ComposerContextLabel>
        </TooltipTrigger>
        <TooltipPopup>
          {workspaceLabel}
          {shortcutLabel ? ` · ${shortcutLabel}` : null}
        </TooltipPopup>
      </Tooltip>
      <MenuPopup align="start" side="top" {...composerFloatingLayerProps}>
        <WorkspaceMenuItems
          envMode={effectiveEnvMode}
          locked={envLocked}
          forceNewWorktree={forceNewWorktree}
          localLabel={resolveCurrentWorkspaceLabel(activeWorktreePath)}
          sshDestination={sshDestination}
          sshOptions={sshOptions}
          sshDisabledReason={sshDisabledReason}
          onEnvModeChange={onEnvModeChange}
          onSshDestinationChange={(destination) => onSshDestinationChange?.(destination)}
        />
      </MenuPopup>
    </Menu>
  );
});
