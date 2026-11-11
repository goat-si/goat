import { useAtomValue } from "@effect/atom-react";
import { DateTimePicker } from "@expo/ui/community/datetime-picker";
import { scopeThreadRef } from "@goat/client-runtime/environment";
import {
  checkInRoutineInput,
  findCheckInRoutine,
  WEEKDAY_LABELS,
} from "@goat/client-runtime/scheduledTasks";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@goat/client-runtime/state/runtime";
import type { EnvironmentId, ScheduledTask, ThreadId } from "@goat/contracts";
import { useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { appAtomRegistry } from "../../state/atom-registry";
import { useThreadShell } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { MOBILE_CHECK_IN_DRAFT, type MobileCheckInDraft } from "./mobileCheckInDraft";

const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

/** Offers the one-tap check-in routine while the bot has none, and creates it. */
export function MobileBotCheckInForm(props: {
  readonly environmentId: EnvironmentId;
  readonly botThreadId: ThreadId;
  readonly tasks: readonly Pick<ScheduledTask, "id" | "title" | "threadId">[];
  readonly botName?: string;
  readonly draft: MobileCheckInDraft;
  readonly onDraftChange: (draft: MobileCheckInDraft) => void;
}) {
  const bot = useThreadShell(scopeThreadRef(props.environmentId, props.botThreadId));
  const canCreate = useAtomValue(
    serverEnvironment.upsertScheduledTask.permissionAtom(props.environmentId),
  );
  const { draft, onDraftChange } = props;
  const { open, timeOfDay, weekdays } = draft;
  const setOpen = (value: boolean) =>
    onDraftChange(value ? { ...draft, open: true } : MOBILE_CHECK_IN_DRAFT);
  const setTimeOfDay = (value: string) => onDraftChange({ ...draft, timeOfDay: value });
  const setWeekdays = (value: readonly number[]) => onDraftChange({ ...draft, weekdays: value });
  const [pickingTime, setPickingTime] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const botName = props.botName ?? "GOAT Bot";
  if (!canCreate || findCheckInRoutine(props.tasks, props.botThreadId) !== undefined) return null;
  if (!open) {
    return (
      <Pressable
        accessibilityRole="button"
        onPress={() => setOpen(true)}
        className="min-h-[44px] justify-center self-start"
      >
        <Text className="text-foreground">Check in on me</Text>
      </Pressable>
    );
  }
  const toggleDay = (day: number) => {
    const next = weekdays.includes(day) ? weekdays.filter((d) => d !== day) : [...weekdays, day];
    if (next.length > 0) setWeekdays(next);
  };
  const save = async () => {
    if (bot === null || saving) return;
    setSaving(true);
    setError(null);
    const result = await runAtomCommand(
      appAtomRegistry,
      serverEnvironment.upsertScheduledTask,
      {
        environmentId: props.environmentId,
        input: checkInRoutineInput({
          bot: { projectId: bot.projectId, threadId: bot.id },
          modelSelection: bot.modelSelection,
          creationSource: "mobile",
          timeOfDay,
          weekdays,
        }),
      },
      { label: "GOAT Bot check-in routine", reportFailure: false },
    );
    setSaving(false);
    if (result._tag === "Success") {
      setOpen(false);
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const failure = squashAtomCommandFailure(result);
    setError(failure instanceof Error ? failure.message : String(failure));
  };
  return (
    <View className="gap-2 border-b border-border py-2">
      <Text className="text-foreground-muted">
        {botName} looks over your open work and messages you only when something needs you.
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Check-in time, ${timeOfDay}`}
        onPress={() => setPickingTime((value) => !value)}
        className="min-h-[44px] flex-row items-center justify-between"
      >
        <Text className="text-foreground">Time</Text>
        <Text className="text-foreground-muted">{timeOfDay}</Text>
      </Pressable>
      {pickingTime ? (
        <DateTimePicker
          value={timeValue(timeOfDay)}
          mode="time"
          display={Platform.OS === "ios" ? "spinner" : "default"}
          onDismiss={() => setPickingTime(false)}
          onValueChange={(_, selected) =>
            setTimeOfDay(
              `${String(selected.getHours()).padStart(2, "0")}:${String(selected.getMinutes()).padStart(2, "0")}`,
            )
          }
        />
      ) : null}
      <View className="flex-row flex-wrap gap-2">
        {WEEK_ORDER.map((day) => (
          <Pressable
            key={day}
            accessibilityRole="button"
            accessibilityState={{ selected: weekdays.includes(day) }}
            onPress={() => toggleDay(day)}
            className={
              weekdays.includes(day)
                ? "min-h-[44px] justify-center rounded-md bg-thread-selected px-3"
                : "min-h-[44px] justify-center px-3"
            }
          >
            <Text className="text-foreground">{WEEKDAY_LABELS[day]}</Text>
          </Pressable>
        ))}
      </View>
      {error !== null ? (
        <Text accessibilityRole="alert" className="text-danger-foreground">
          Couldn't save the check-in: {error}
        </Text>
      ) : null}
      <View className="flex-row justify-end gap-4">
        <Pressable
          accessibilityRole="button"
          onPress={() => setOpen(false)}
          className="min-h-[44px] justify-center"
        >
          <Text className="text-foreground">Cancel</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: bot === null || saving }}
          disabled={bot === null || saving}
          onPress={() => void save()}
          className="min-h-[44px] justify-center"
        >
          <Text className="font-semibold text-foreground">Save</Text>
        </Pressable>
      </View>
    </View>
  );
}

function timeValue(timeOfDay: string): Date {
  const [hours, minutes] = timeOfDay.split(":").map(Number);
  const time = new Date();
  time.setHours(hours ?? 9, minutes ?? 0, 0, 0);
  return time;
}
