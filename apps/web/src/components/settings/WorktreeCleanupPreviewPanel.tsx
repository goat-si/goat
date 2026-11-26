import { useGT, useLocale } from "gt-react";
import { WORKTREE_CLEANUP_OFF } from "@goat/contracts";
import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@goat/client-runtime/state/runtime";
import type { EnvironmentId, WorktreeCleanupPreview } from "@goat/contracts";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsRow } from "./settingsLayout";

export function WorktreeCleanupPreviewPanel({
  environmentId,
  preview,
}: {
  environmentId: EnvironmentId;
  preview: WorktreeCleanupPreview;
}) {
  const gt = useGT();
  const locale = useLocale();
  const canRespond = useAtomValue(
    serverEnvironment.respondWorktreeCleanupPreview.permissionAtom(environmentId),
  );
  const canUpdate = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const respond = useAtomCommand(serverEnvironment.respondWorktreeCleanupPreview);
  const update = useAtomCommand(serverEnvironment.updateSettings);
  return (
    <SettingsGroup>
      <SettingsRow
        title={gt("Worktree cleanup preview")}
        description={
          <span>
            {preview.plannedCount === 1
              ? gt("1 worktree matches the cleanup rules below.")
              : gt("{count} worktrees match the cleanup rules below.", {
                  count: preview.plannedCount,
                })}{" "}
            {gt(
              "A snapshot of any uncommitted changes is saved first, and you can restore a worktree from its thread.",
            )}{" "}
            {preview.activatesAt
              ? gt("Cleanup starts {time}.", { time: relativeStart(preview.activatesAt, locale) })
              : gt("Cleanup starts when you confirm.")}
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
                }).then(showFailure(gt("Could not start worktree cleanup")))
              }
            >
              {gt("Clean up now")}
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
                      storageCleanup: WORKTREE_CLEANUP_OFF,
                    },
                  },
                }).then(showFailure(gt("Could not turn off worktree cleanup")))
              }
            >
              {gt("Turn off")}
            </Button>
          </div>
        }
      />
    </SettingsGroup>
  );
}

function relativeStart(isoDate: string, locale: string) {
  const hours = Math.ceil((Date.parse(isoDate) - Date.now()) / 3_600_000);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (hours <= 0) return format.format(0, "second");
  return hours < 24 ? format.format(hours, "hour") : format.format(Math.ceil(hours / 24), "day");
}

const showFailure = (title: string) => (result: AtomCommandResult<unknown, unknown>) => {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : String(error),
  });
};
