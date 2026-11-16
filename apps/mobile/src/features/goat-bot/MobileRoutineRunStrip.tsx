import {
  botRoutineRuns,
  routineRunFinished,
  routineRunState,
  routineRunTime,
  type RoutineRunDot,
  type RoutineRunShape,
} from "@goat/client-runtime/scheduledTasks";
import type { ChannelInputSnapshot, EnvironmentId, ScheduledTask } from "@goat/contracts";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";

import { channelEnvironment } from "../../state/channels";
import { useEnvironmentQuery } from "../../state/query";

const RUNS_SHOWN = 7;

type RunTask = Partial<Pick<ScheduledTask, "recentRuns" | "lastRunError">> & {
  readonly lastRun?: Pick<NonNullable<ScheduledTask["lastRun"]>, "firingId"> | undefined;
};
type TimeOptions = Parameters<typeof routineRunFinished>[2];

/**
 * A routine's recent runs as dots, oldest first, and the run the person opened, under the strip.
 * The phone has no 12/24-hour setting, so times follow the device's locale.
 */
export function MobileRoutineRunStrip(props: {
  readonly environmentId: EnvironmentId;
  readonly task: RunTask;
  readonly title: string;
  readonly botName: string;
  readonly timeOptions?: TimeOptions | undefined;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const dots = botRoutineRuns(props.task, RUNS_SHOWN, (iso) =>
    routineRunTime(iso, props.timeOptions),
  );
  // A run that leaves the seven closes its panel, and stays closed if it comes back.
  if (openId !== null && !dots.some((dot) => dot.firingId === openId)) setOpenId(null);
  if (dots.length === 0) return null;
  const open = dots.find((dot) => dot.firingId === openId) ?? null;
  return (
    <View className="gap-1">
      <View accessibilityLabel={`Recent runs of ${props.title}`} className="flex-row flex-wrap">
        {dots.map((dot) => (
          <Pressable
            key={dot.firingId}
            accessibilityRole="button"
            accessibilityLabel={dot.accessibleName}
            accessibilityState={{ expanded: dot === open }}
            onPress={() => setOpenId(dot === open ? null : dot.firingId)}
            className={`h-11 w-11 items-center justify-center rounded-full ${dot === open ? "bg-subtle-strong" : ""}`}
          >
            <RunShape shape={dot.shape} />
          </Pressable>
        ))}
      </View>
      {open ? (
        <MobileRoutineRunPanel
          key={open.firingId}
          environmentId={props.environmentId}
          dot={open}
          newest={open === dots.at(-1)}
          task={props.task}
          botName={props.botName}
          timeOptions={props.timeOptions}
        />
      ) : null}
    </View>
  );
}

function RunShape(props: { readonly shape: RoutineRunShape }) {
  switch (props.shape) {
    case "filled-circle":
      return <View className="h-3 w-3 rounded-full bg-foreground" />;
    case "bar":
      return <View className="h-1 w-3 rounded-sm bg-foreground-muted" />;
    case "filled-square":
      return <View className="h-3 w-3 bg-danger-foreground" />;
    case "hollow-diamond":
      return <View className="h-2.5 w-2.5 rotate-45 border border-foreground-muted" />;
    case "hollow-square":
      return <View className="h-3 w-3 border border-foreground-muted" />;
  }
}

function MobileRoutineRunPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly dot: RoutineRunDot;
  readonly newest: boolean;
  readonly task: RunTask;
  readonly botName: string;
  readonly timeOptions: TimeOptions | undefined;
}) {
  const { dot } = props;
  const state = routineRunState(dot);
  const inputId = dot.conversation?.inputId;
  const quiet = dot.quiet === true && dot.status === "completed";
  // Only an ended run with a conversation is read; a run still going reads once the list says so.
  const readable = state === "ended" && !quiet && dot.dispatchFailed !== true;
  const read = useEnvironmentQuery(
    readable && inputId !== undefined
      ? channelEnvironment.getInput({ environmentId: props.environmentId, input: { inputId } })
      : null,
  );
  const word = dot.word.charAt(0).toUpperCase() + dot.word.slice(1);
  const finished = routineRunFinished(dot.requestedAt, dot.completedAt, props.timeOptions);
  const body = runBody({ ...props, state, quiet, inputId, read });
  return (
    <View className="gap-1 pb-1">
      <Text className="text-foreground">
        {word} · {routineRunTime(dot.requestedAt, props.timeOptions)}
        {finished === null ? "" : `, ${finished}`}
      </Text>
      {/* A changed reply (an error, another answer) starts collapsed and is measured again. */}
      <MobileRunReply key={body} body={body} />
    </View>
  );
}

function MobileRunReply(props: { readonly body: string }) {
  const { body } = props;
  const [expanded, setExpanded] = useState(false);
  const [long, setLong] = useState(false);
  return (
    <>
      <View>
        <Text numberOfLines={expanded ? undefined : 6} className="text-foreground-muted">
          {body}
        </Text>
        {/* An unclamped copy, unseen and unread, measures whether the reply needs more lines. */}
        {expanded ? null : (
          <View
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            className="absolute left-0 right-0 top-0 opacity-0"
          >
            <Text
              className="text-foreground-muted"
              onTextLayout={(event) => setLong(event.nativeEvent.lines.length > 6)}
            >
              {body}
            </Text>
          </View>
        )}
      </View>
      {long ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={expanded ? "Show less of the reply" : "Show the full reply"}
          accessibilityState={{ expanded }}
          onPress={() => setExpanded((value) => !value)}
          className="min-h-[44px] justify-center self-start"
        >
          <Text className="font-goat-medium text-primary-text">
            {expanded ? "Show less" : "Show more"}
          </Text>
        </Pressable>
      ) : null}
    </>
  );
}

function runBody(input: {
  readonly dot: RoutineRunDot;
  readonly newest: boolean;
  readonly task: RunTask;
  readonly botName: string;
  readonly state: ReturnType<typeof routineRunState>;
  readonly quiet: boolean;
  readonly inputId: string | undefined;
  readonly read: { readonly data: ChannelInputSnapshot | null; readonly error: unknown };
}): string {
  const { dot } = input;
  if (input.state === "in-flight") return "Still running.";
  if (input.quiet) return "No update";
  if (dot.dispatchFailed === true) {
    const error =
      input.newest && input.task.lastRun?.firingId === dot.firingId
        ? input.task.lastRunError?.split("\n")[0]?.trim()
        : undefined;
    return error || `This run didn't reach ${input.botName}.`;
  }
  if (input.state === "unsettled" || input.inputId === undefined)
    return "Details for this run aren't available.";
  if (input.read.error) return "Couldn't load this run.";
  const snapshot = input.read.data;
  if (snapshot === null) return "Loading…";
  return (
    snapshot.reply?.text ?? snapshot.failure?.message ?? "Details for this run aren't available."
  );
}
