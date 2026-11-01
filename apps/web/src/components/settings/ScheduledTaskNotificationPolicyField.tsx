import { useState, type ReactNode } from "react";
import { Label } from "../ui/label";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import type { DraftState } from "./scheduledTasksSettings.logic";

export function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="flex items-baseline justify-between" htmlFor={htmlFor}>
        <span>{label}</span>
        {hint ? (
          <span className="font-normal text-2xs text-muted-foreground/80">{hint}</span>
        ) : null}
      </Label>
      {children}
    </div>
  );
}

const choices = [
  { value: "all_runs", label: "All runs" },
  { value: "failed_runs_only", label: "Failed runs only" },
  { value: "important_updates", label: "Important updates" },
];
export function ScheduledTaskNotificationPolicyField({
  draft,
  onChange,
}: {
  draft: DraftState;
  onChange: (patch: Partial<DraftState>) => void;
}) {
  const [reset, setReset] = useState(false);
  const known = choices.find((choice) => choice.value === draft.notificationPolicy);
  return (
    <Field label="Notifications" htmlFor="scheduled-task-notifications">
      <Select
        value={draft.notificationPolicy}
        onValueChange={(value) => {
          if (value) onChange({ notificationPolicy: value });
        }}
      >
        <SelectTrigger id="scheduled-task-notifications" size="sm">
          <SelectValue>{known?.label ?? "Unsupported policy (kept)"}</SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {choices
            .filter((choice) => choice.value !== "important_updates" || draft.threadId !== "")
            .map((choice) => (
              <SelectItem key={choice.value} value={choice.value}>
                {choice.label}
              </SelectItem>
            ))}
        </SelectPopup>
      </Select>
      {known === undefined ? (
        <p className="text-sm text-muted-foreground">
          This environment uses a newer policy. It stays saved unless you choose another option.
        </p>
      ) : null}
      {draft.threadId ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            const important = draft.notificationPolicy === "important_updates";
            onChange({ threadId: "", ...(important ? { notificationPolicy: "all_runs" } : {}) });
            setReset(important);
          }}
        >
          Run in new threads
        </Button>
      ) : null}
      {reset ? (
        <p role="status" className="text-sm text-muted-foreground">
          Notifications changed to All runs because Important updates requires an existing thread.
        </p>
      ) : null}
    </Field>
  );
}
