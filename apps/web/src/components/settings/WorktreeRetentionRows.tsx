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
  return (
    <>
      <SettingsRow
        title="Keep the most recently used worktrees"
        status={status("worktreeKeepRecent")}
        serverScoped={!isProjectScope}
        control={
          <RetentionControl
            label="Keep the most recently used worktrees"
            value={settings.worktreeKeepRecent}
            maximum={1000}
            unit="worktrees"
            onChange={(worktreeKeepRecent, onFailed) =>
              updateWorktree({ worktreeKeepRecent }, { onFailed })
            }
          />
        }
      />
      <SettingsRow
        title="Clean up when a thread is archived"
        status={status("worktreeOnArchive")}
        serverScoped={!isProjectScope}
        control={
          <Switch
            aria-label="Clean up when a thread is archived"
            checked={settings.worktreeOnArchive}
            onCheckedChange={(worktreeOnArchive) => updateWorktree({ worktreeOnArchive })}
          />
        }
      />
      <SettingsRow
        title="Clean up worktrees with uncommitted changes"
        description="A snapshot of the changes is saved first."
        status={status("worktreeSnapshotChanges")}
        serverScoped={!isProjectScope}
        control={
          <Switch
            aria-label="Clean up worktrees with uncommitted changes"
            checked={settings.worktreeSnapshotChanges}
            onCheckedChange={(worktreeSnapshotChanges) =>
              updateWorktree({ worktreeSnapshotChanges })
            }
          />
        }
      />
      {!isProjectScope && (
        <SettingsRow
          title="Keep snapshots for"
          status={status("worktreeSnapshotDays")}
          serverScoped
          control={
            <RetentionControl
              label="Keep snapshots for"
              value={settings.worktreeSnapshotDays}
              offLabel="Forever"
              onChange={(worktreeSnapshotDays, onFailed) =>
                update({ worktreeSnapshotDays }, { onFailed })
              }
            />
          }
        />
      )}
      {!isProjectScope && (
        <SettingsRow
          title="Preview before automatic cleanup"
          description="Cleanup waits until you have seen what it would remove."
          status={status("worktreeCleanupPreview")}
          serverScoped
          control={
            <Switch
              aria-label="Preview before automatic cleanup"
              checked={settings.worktreeCleanupPreview}
              onCheckedChange={(worktreeCleanupPreview) => update({ worktreeCleanupPreview })}
            />
          }
        />
      )}
    </>
  );
}
