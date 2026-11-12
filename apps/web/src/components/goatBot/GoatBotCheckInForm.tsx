import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@goat/client-runtime/environment";
import {
  CHECK_IN_DEFAULT_TIME,
  CHECK_IN_DEFAULT_WEEKDAYS,
  checkInRoutineInput,
  WEEKDAY_LABELS,
} from "@goat/client-runtime/scheduledTasks";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@goat/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId } from "@goat/contracts";
import { useState } from "react";
import { useThreadShell } from "~/state/entities";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Toggle } from "../ui/toggle";
import { ToggleGroup } from "../ui/toggle-group";
import { useGoatBotName } from "./goatBotMemberContext";
import { HoldsNavigation } from "~/lib/navigationHolds";

const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

export function GoatBotCheckInForm(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly onClose: () => void;
}) {
  const bot = useThreadShell(scopeThreadRef(props.environmentId, props.threadId));
  const canSave = useAtomValue(
    serverEnvironment.upsertScheduledTask.permissionAtom(props.environmentId),
  );
  const upsert = useAtomCommand(serverEnvironment.upsertScheduledTask, {
    label: "GOAT Bot check-in routine",
    reportFailure: false,
  });
  const [timeOfDay, setTimeOfDay] = useState(CHECK_IN_DEFAULT_TIME);
  const [weekdays, setWeekdays] = useState<readonly number[]>(CHECK_IN_DEFAULT_WEEKDAYS);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const botName = useGoatBotName();
  const save = async () => {
    if (bot === null || saving) return;
    setSaving(true);
    setError(null);
    const result = await upsert({
      environmentId: props.environmentId,
      input: checkInRoutineInput({
        bot: { projectId: bot.projectId, threadId: bot.id },
        modelSelection: bot.modelSelection,
        creationSource: "web",
        timeOfDay,
        weekdays,
      }),
    });
    setSaving(false);
    if (result._tag === "Success") {
      props.onClose();
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const failure = squashAtomCommandFailure(result);
    setError(failure instanceof Error ? failure.message : String(failure));
  };
  return (
    <form
      aria-label="Check in on me"
      className="space-y-3 rounded-md border border-border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <HoldsNavigation />
      <p className="text-xs text-muted-foreground">
        {botName} looks over your open work and messages you only when something needs you.
      </p>
      <div className="flex items-center gap-2">
        <Label htmlFor="goat-bot-check-in-time">At</Label>
        <Input
          type="time"
          id="goat-bot-check-in-time"
          nativeInput
          required
          className="w-32"
          value={timeOfDay}
          onChange={(event) => setTimeOfDay(event.target.value)}
        />
      </div>
      <ToggleGroup
        multiple
        variant="outline"
        size="sm"
        aria-label="Days to check in"
        value={weekdays.map(String)}
        onValueChange={(values) => {
          if (values.length > 0) setWeekdays(values.map(Number));
        }}
      >
        {WEEK_ORDER.map((day) => (
          <Toggle key={day} value={String(day)}>
            {WEEKDAY_LABELS[day]}
          </Toggle>
        ))}
      </ToggleGroup>
      {error !== null ? (
        <p role="alert" className="text-xs text-destructive">
          Couldn't save the check-in: {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={props.onClose}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!canSave || bot === null || saving || !timeOfDay}>
          Save
        </Button>
      </div>
    </form>
  );
}
