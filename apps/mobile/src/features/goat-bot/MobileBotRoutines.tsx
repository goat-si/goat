import { useAtomValue } from "@effect/atom-react";
import type { BotRoutineRow } from "@goat/client-runtime/scheduledTasks";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@goat/client-runtime/state/runtime";
import type { EnvironmentId, ScheduledTask, ThreadId } from "@goat/contracts";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";

import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { appAtomRegistry } from "../../state/atom-registry";
import { serverEnvironment } from "../../state/server";
import { MobileBotCheckInForm } from "./MobileBotCheckInForm";
import type { MobileCheckInDraft, MobileCheckInDraftUpdate } from "./mobileCheckInDraft";
import { MobileBotPanelEmpty } from "./MobileBotPanelEmpty";

/** What New routine puts in the message box: the person finishes the sentence. */
export const GOAT_BOT_NEW_ROUTINE_DRAFT = "Set up a routine: ";

/** The bot's routines on its home: the check-in form, then each bound routine with its switch. */
export function MobileBotRoutines(props: {
  readonly environmentId: EnvironmentId | null;
  readonly connected: boolean;
  readonly botThreadId: ThreadId | null;
  readonly botName: string;
  readonly tasks: ReadonlyArray<ScheduledTask> | null;
  readonly error: boolean;
  readonly onRetry: () => void;
  readonly rows: ReadonlyArray<BotRoutineRow>;
  readonly showAll: boolean;
  readonly onShowAllChange: (showAll: boolean) => void;
  /** A routine the home opened on; its row reports where it sits so the list can scroll to it. */
  readonly focusRoutineId?: string | null | undefined;
  readonly onFocusedRowLayout?: ((y: number) => void) | undefined;
  /** Starts a routine request in the chat's message box; absent while the chat cannot send. */
  readonly onNewRoutine?: (() => void) | undefined;
  /** The check-in being set up, kept by the Home list across its cell unmounting. */
  readonly checkInDraft: MobileCheckInDraft;
  readonly onCheckInDraftChange: MobileCheckInDraftUpdate;
}) {
  const { environmentId, botName } = props;
  // Asking the bot for a routine needs no list, so the entry point never waits on it.
  const newRoutine = props.onNewRoutine ? (
    <Pressable
      accessibilityRole="button"
      onPress={props.onNewRoutine}
      className="min-h-[44px] justify-center self-start"
    >
      <Text className="text-foreground underline">New routine</Text>
    </Pressable>
  ) : null;
  return (
    <>
      {props.connected && props.tasks && environmentId && props.botThreadId ? (
        <MobileBotCheckInForm
          environmentId={environmentId}
          botThreadId={props.botThreadId}
          tasks={props.tasks}
          botName={botName}
          draft={props.checkInDraft}
          onDraftChange={props.onCheckInDraftChange}
        />
      ) : null}
      {!props.connected ? (
        <Text className="text-foreground-muted">
          Routines are unavailable while {botName} is offline.
        </Text>
      ) : props.error ? (
        <Pressable
          accessibilityRole="button"
          onPress={props.onRetry}
          className="min-h-[44px] justify-center"
        >
          <Text className="text-danger-foreground">Couldn't load routines. Try again</Text>
        </Pressable>
      ) : !props.tasks ? (
        <Text className="text-foreground-muted">Loading routines…</Text>
      ) : props.rows.length && environmentId ? (
        (props.showAll ? props.rows : props.rows.slice(0, 5)).map((routine) => (
          <MobileRoutineRow
            key={routine.id}
            environmentId={environmentId}
            row={routine}
            onLayout={
              routine.id === props.focusRoutineId && props.onFocusedRowLayout
                ? (y) => props.onFocusedRowLayout?.(y)
                : undefined
            }
          />
        ))
      ) : (
        <MobileBotPanelEmpty
          title="No routines yet"
          next={
            newRoutine
              ? `Ask ${botName} in chat to set up a routine, or start with New routine.`
              : `Ask ${botName} in chat to set up a routine.`
          }
        />
      )}
      {props.rows.length > 5 ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => props.onShowAllChange(!props.showAll)}
          className="min-h-[44px] items-center justify-center"
        >
          <Text className="text-foreground">{props.showAll ? "Show less" : "Show more"}</Text>
        </Pressable>
      ) : null}
    </>
  );
}

function MobileRoutineRow(props: {
  readonly environmentId: EnvironmentId;
  readonly row: BotRoutineRow;
  readonly onLayout?: ((y: number) => void) | undefined;
}) {
  const { environmentId, row } = props;
  const canOperate = useAtomValue(
    serverEnvironment.setScheduledTaskEnabled.permissionAtom(environmentId),
  );
  const canRunNow = useAtomValue(
    serverEnvironment.runScheduledTaskNow.permissionAtom(environmentId),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const runAgain = async () => {
    if (running) return;
    setRunning(true);
    setRunError(null);
    const result = await runAtomCommand(
      appAtomRegistry,
      serverEnvironment.runScheduledTaskNow,
      { environmentId, input: { id: row.id } },
      { label: "GOAT Bot routine run now", reportFailure: false },
    );
    setRunning(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setRunError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  const toggle = async (enabled: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await runAtomCommand(
      appAtomRegistry,
      serverEnvironment.setScheduledTaskEnabled,
      { environmentId, input: { id: row.id, enabled } },
      { label: "GOAT Bot routine enabled", reportFailure: false },
    );
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  return (
    <View
      className="gap-1 border-b border-border py-2"
      onLayout={
        props.onLayout ? (event) => props.onLayout?.(event.nativeEvent.layout.y) : undefined
      }
    >
      <View className="flex-row items-center gap-3">
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          onPress={() => setExpanded((value) => !value)}
          className="min-h-[44px] flex-1 justify-center"
        >
          <Text className="font-semibold text-foreground">{row.title}</Text>
          <Text className="text-foreground-muted">
            {row.scheduleText} · {row.nextText}
          </Text>
          <Text className={row.lastFailed ? "text-danger-foreground" : "text-foreground-muted"}>
            {row.lastText}
          </Text>
        </Pressable>
        <ThemedSwitch
          accessibilityLabel={`${row.enabled ? "Pause" : "Resume"} ${row.title}`}
          disabled={busy || !canOperate}
          value={row.enabled}
          onValueChange={(enabled) => void toggle(enabled)}
        />
      </View>
      {expanded ? <Text className="text-foreground-muted">{row.prompt}</Text> : null}
      {row.lastFailed && canRunNow ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: running }}
          disabled={running}
          onPress={() => void runAgain()}
          className="min-h-[44px] self-start justify-center"
        >
          <Text className="text-foreground">Run now</Text>
        </Pressable>
      ) : null}
      {error !== null ? (
        <Text accessibilityRole="alert" className="text-danger-foreground">
          Couldn't {row.enabled ? "pause" : "resume"} this routine: {error}
        </Text>
      ) : null}
      {runError !== null ? (
        <Text accessibilityRole="alert" className="text-danger-foreground">
          Couldn't run this routine: {runError}
        </Text>
      ) : null}
    </View>
  );
}

/** Runs failed or stopped work again; each tap is its own request and the server may refuse. */
