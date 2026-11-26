import { useGT } from "gt-react";
import type { StorageCleanupSettings, WorktreeCleanupRules } from "@goat/contracts";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";
import { RetentionControl } from "./RetentionControl";

export function WorktreeRetentionRows({
  settings,
  isProjectScope,
  status,
  updateWorktree,
  update,
}: {
  settings: StorageCleanupSettings;
  isProjectScope: boolean;
  status: (key: keyof StorageCleanupSettings) => string | undefined;
  updateWorktree: (
    patch: Partial<WorktreeCleanupRules>,
    options?: { onFailed?: () => void },
  ) => void;
  update: (patch: Partial<StorageCleanupSettings>, options?: { onFailed?: () => void }) => void;
}) {
  const gt = useGT();
  return (
    <>
      <SettingsRow
        title={gt("Keep the most recently used worktrees")}
        status={status("worktreeKeepRecent")}
        serverScoped={!isProjectScope}
        control={
          <RetentionControl
            label={gt("Keep the most recently used worktrees")}
            value={settings.worktreeKeepRecent}
            maximum={1000}
            unit={gt("worktrees")}
            onChange={(worktreeKeepRecent, onFailed) =>
              updateWorktree({ worktreeKeepRecent }, { onFailed })
            }
          />
        }
      />
      <SettingsRow
        title={gt("Clean up when a thread is archived")}
        status={status("worktreeOnArchive")}
        serverScoped={!isProjectScope}
        control={
          <Switch
            aria-label={gt("Clean up when a thread is archived")}
            checked={settings.worktreeOnArchive}
            onCheckedChange={(worktreeOnArchive) => updateWorktree({ worktreeOnArchive })}
          />
        }
      />
      <SettingsRow
        title={gt("Clean up worktrees with uncommitted changes")}
        description={gt("A snapshot of the changes is saved first.")}
        status={status("worktreeSnapshotChanges")}
        serverScoped={!isProjectScope}
        control={
          <Switch
            aria-label={gt("Clean up worktrees with uncommitted changes")}
            checked={settings.worktreeSnapshotChanges}
            onCheckedChange={(worktreeSnapshotChanges) =>
              updateWorktree({ worktreeSnapshotChanges })
            }
          />
        }
      />
      {!isProjectScope && (
        <SettingsRow
          title={gt("Keep snapshots for")}
          status={status("worktreeSnapshotDays")}
          serverScoped
          control={
            <RetentionControl
              label={gt("Keep snapshots for")}
              value={settings.worktreeSnapshotDays}
              offLabel={gt("Forever")}
              onChange={(worktreeSnapshotDays, onFailed) =>
                update({ worktreeSnapshotDays }, { onFailed })
              }
            />
          }
        />
      )}
      {!isProjectScope && (
        <SettingsRow
          title={gt("Preview before automatic cleanup")}
          description={gt("Cleanup waits until you have seen what it would remove.")}
          status={status("worktreeCleanupPreview")}
          serverScoped
          control={
            <Switch
              aria-label={gt("Preview before automatic cleanup")}
              checked={settings.worktreeCleanupPreview}
              onCheckedChange={(worktreeCleanupPreview) => update({ worktreeCleanupPreview })}
            />
          }
        />
      )}
    </>
  );
}
