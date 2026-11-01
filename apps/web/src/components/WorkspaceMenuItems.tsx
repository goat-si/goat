import type { DraftSshDestination } from "../composerDraftStore";
import type { SavedSshWorktreeOption } from "../lib/sshWorktree";
import type { EnvMode } from "./BranchToolbar.logic";
import {
  MenuGroup,
  MenuGroupLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSub,
  MenuSubTrigger,
  MenuSubPopup,
  MenuItem,
} from "./ui/menu";

export interface WorkspaceMenuItemsProps {
  envMode: EnvMode;
  locked: boolean;
  forceNewWorktree: boolean;
  localLabel: string;
  sshDestination: DraftSshDestination | null;
  sshOptions: ReadonlyArray<SavedSshWorktreeOption>;
  sshDisabledReason: string | null;
  onEnvModeChange: (mode: EnvMode) => void;
  onSshDestinationChange: (destination: DraftSshDestination) => void;
}
export function WorkspaceMenuItems(props: WorkspaceMenuItemsProps) {
  const sharedReason =
    props.sshDisabledReason ??
    (props.forceNewWorktree ? "Choose one model before sending to SSH." : null);
  return (
    <MenuGroup>
      <MenuGroupLabel>Workspace</MenuGroupLabel>
      <MenuRadioGroup value={props.sshDestination ? "ssh" : props.envMode}>
        <MenuRadioItem
          value="local"
          closeOnClick
          disabled={props.locked || props.forceNewWorktree}
          onClick={() => props.onEnvModeChange("local")}
        >
          {props.localLabel}
        </MenuRadioItem>
        <MenuRadioItem
          value="worktree"
          closeOnClick
          disabled={props.locked}
          onClick={() => props.onEnvModeChange("worktree")}
        >
          New worktree
        </MenuRadioItem>
      </MenuRadioGroup>
      {props.sshOptions.length > 0 ? (
        <MenuSub>
          {/* The submenu stays openable while blocked so the hosts and the reason stay visible. */}
          <MenuSubTrigger disabled={props.locked}>Work on SSH</MenuSubTrigger>
          <MenuSubPopup>
            {sharedReason ? (
              <p className="max-w-64 px-2 py-1.5 text-muted-foreground text-xs">{sharedReason}</p>
            ) : null}
            {props.sshOptions.map((option) => {
              const reason = sharedReason ? null : option.disabledReason;
              return (
                <MenuItem
                  key={`${option.destination.environmentId}:${option.destination.connectionId}`}
                  disabled={sharedReason !== null || option.disabledReason !== null}
                  closeOnClick
                  onClick={() => props.onSshDestinationChange(option.destination)}
                >
                  <span className="flex min-w-0 max-w-64 flex-col">
                    <span className="truncate">
                      {option.label}
                      {option.destination.connectionId === props.sshDestination?.connectionId &&
                      option.destination.environmentId === props.sshDestination?.environmentId ? (
                        <span aria-label="Selected"> ✓</span>
                      ) : null}
                    </span>
                    {reason ? (
                      <span className="text-muted-foreground text-xs">{reason}</span>
                    ) : null}
                  </span>
                </MenuItem>
              );
            })}
          </MenuSubPopup>
        </MenuSub>
      ) : null}
    </MenuGroup>
  );
}
