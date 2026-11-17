import { AppText as Text } from "../../components/ui/AppText";
import { SelectRow } from "./ScheduledTaskFormFields";
import { offersImportantUpdates, type ScheduledTaskDraft } from "./scheduledTaskDraft";

const choices = [
  { id: "all_runs", title: "All runs" },
  { id: "failed_runs_only", title: "Failed runs only" },
  { id: "important_updates", title: "Important updates" },
];
export function ScheduledTaskNotificationPolicySection({
  draft,
  threadModes,
  disabled,
  onChange,
}: {
  draft: ScheduledTaskDraft;
  threadModes: boolean;
  disabled: boolean;
  /** A chosen policy replaces the reset notice. */
  onChange: (draft: ScheduledTaskDraft) => void;
}) {
  const label = choices.find((c) => c.id === draft.notificationPolicy)?.title;
  return (
    <>
      <SelectRow
        label="Notifications"
        value={label ?? "Unsupported policy (kept)"}
        borderTop
        actions={
          disabled
            ? []
            : choices
                .filter(
                  (c) => c.id !== "important_updates" || offersImportantUpdates(draft, threadModes),
                )
                .map((c) => ({ ...c, state: c.id === draft.notificationPolicy ? "on" : undefined }))
        }
        onSelect={(id) =>
          onChange({ ...draft, notificationPolicy: id, notificationPolicyReset: false })
        }
      />
      {draft.notificationPolicyReset ? (
        <Text className="px-4 pb-3 text-sm text-foreground-muted">
          Notifications changed to All runs because Important updates requires an existing thread.
        </Text>
      ) : null}
      {label === undefined ? (
        <Text className="px-4 pb-3 text-sm text-foreground-muted">
          This environment uses a newer policy. It stays saved unless you choose another option.
        </Text>
      ) : null}
    </>
  );
}
