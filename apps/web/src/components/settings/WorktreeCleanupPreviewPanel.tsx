import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, WorktreeCleanupPreview } from "@goat/contracts";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsRow } from "./settingsLayout";

export function WorktreeCleanupPreviewPanel({
  environmentId,
  preview,
}: {
  environmentId: EnvironmentId;
  preview: WorktreeCleanupPreview;
}) {
  const canRespond = useAtomValue(
    serverEnvironment.respondWorktreeCleanupPreview.permissionAtom(environmentId),
  );
  const canUpdate = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const respond = useAtomCommand(serverEnvironment.respondWorktreeCleanupPreview);
  const update = useAtomCommand(serverEnvironment.updateSettings);
  return (
    <SettingsGroup>
      <SettingsRow
        title="Worktree cleanup preview"
        description={
          <span>
            {preview.plannedCount === 1
              ? "1 worktree matches the cleanup rules below."
              : `${preview.plannedCount} worktrees match the cleanup rules below.`}{" "}
            A snapshot of any uncommitted changes is saved first, and you can restore a worktree
            from its thread.{" "}
            {preview.activatesAt
              ? `Cleanup starts ${relativeStart(preview.activatesAt)}.`
              : "Cleanup starts when you confirm."}
          </span>
        }
        control={
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={!canRespond}
              onClick={() =>
                void respond({
                  environmentId,
                  input: { previewId: preview.id, response: "confirm" },
                })
              }
            >
              Clean up now
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!canUpdate}
              onClick={() =>
                void update({
                  environmentId,
                  input: {
                    patch: {
                      storageCleanup: {
                        worktreeKeepRecent: null,
                        worktreeAfterDays: null,
                        worktreeOnArchive: false,
                      },
                    },
                  },
                })
              }
            >
              Turn off
            </Button>
          </div>
        }
      />
    </SettingsGroup>
  );
}

function relativeStart(isoDate: string) {
  const hours = Math.ceil((Date.parse(isoDate) - Date.now()) / 3_600_000);
  if (hours <= 0) return "now";
  return hours < 24
    ? `in ${hours} ${hours === 1 ? "hour" : "hours"}`
    : Math.ceil(hours / 24) === 1
      ? "in 1 day"
      : `in ${Math.ceil(hours / 24)} days`;
}
