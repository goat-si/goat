import {
  diagnoseGoatBot,
  goatBotName,
  goatBotModelStatus,
  type GoatBotDiagnosticTone,
  type GoatBotDiagnosticsInput,
  type GoatBotWaitingTurn,
} from "@goat/client-runtime/goatBot";
import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@goat/client-runtime/environment";
import type {
  BotProfile,
  ChannelTaskId,
  EnvironmentId,
  SlackChannelStatusEvent,
  ThreadId,
} from "@goat/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect } from "react";
import { Pressable, Text, View } from "react-native";

import { useNowMinuteMs } from "../../lib/clock";
import { channelEnvironment } from "../../state/channels";
import { useEnvironmentServerConfig, useThreadShell } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useMobileGoatBotHomeSettings } from "./useMobileGoatBotHomeSettings";

const NO_SLACK_EVENT = Atom.make<AsyncResult.AsyncResult<SlackChannelStatusEvent, unknown>>(
  AsyncResult.initial(),
);

const TONE_DOT: Record<GoatBotDiagnosticTone, string> = {
  ok: "bg-adaptive-emerald-600-400",
  pending: "bg-foreground-muted",
  // The plain warning and danger colors are pale fills for surfaces; a dot needs the solid tone.
  warn: "bg-warning-foreground",
  error: "bg-danger-foreground",
};

/**
 * Whether the bot can work now, and why not, at the top of the Work sheet. Mobile has no model or
 * Slack settings screens, so it only offers moving the home and going to what waits for an answer.
 */
export function MobileBotStatusCard(props: {
  readonly environmentId: EnvironmentId | null;
  readonly member: {
    readonly threadId: ThreadId;
    readonly defaultModelSelection: BotProfile["defaultModelSelection"];
  } | null;
  readonly rows: GoatBotDiagnosticsInput["rows"];
  readonly refreshRows: () => void;
  readonly turnsWaiting: ReadonlyArray<GoatBotWaitingTurn>;
  /** Absent where the chat is not under Home, as over a task's own screen. */
  readonly onOpenChat?: (() => void) | undefined;
  readonly onOpenTask: (taskId: ChannelTaskId) => void;
  readonly botName?: string;
  /** The main bot, whose model a member uses until it has one of its own. */
  readonly main?: Pick<BotProfile, "name"> | null;
  /** Home shows the card only while something is not ready, as web's Home does. */
  readonly quietWhenReady?: boolean;
}) {
  const { member } = props;
  const home = useMobileGoatBotHomeSettings();
  const homeId = home.resolution.state === "claimed" ? home.resolution.claim.environmentId : null;
  // Read at the home the card names, never at another machine the sheet happens to show.
  const environmentId = homeId ?? props.environmentId;
  const rowsFromHome = homeId === null || homeId === props.environmentId;
  const config = useEnvironmentServerConfig(environmentId);
  const { presentationById } = useEnvironments();
  const presentation = environmentId === null ? undefined : presentationById.get(environmentId);
  const slackSupported =
    member === null &&
    environmentId !== null &&
    presentation?.connection.phase === "connected" &&
    presentation.serverConfig?.environment.capabilities.slackChannel === true;
  const slack = useEnvironmentQuery(
    slackSupported ? channelEnvironment.slackSettings({ environmentId, input: {} }) : null,
  );
  // Pushed status changes; subscribed only while a Slack connection is on.
  const slackStatus = useAtomValue(
    environmentId !== null && slack.data?.some((connection) => connection.enabled) === true
      ? channelEnvironment.slackStatus({ environmentId, input: {} })
      : NO_SLACK_EVENT,
  );
  const slackLive = Option.getOrNull(AsyncResult.value(slackStatus));
  const refreshSlack = slack.refresh;
  // oxlint-disable-next-line goat/react-effect-budget -- The stream names one connection per change; re-read them all so none goes stale.
  useEffect(() => {
    if (slackLive !== null) refreshSlack();
  }, [slackLive, refreshSlack]);
  const memberShell = useThreadShell(
    member === null || environmentId === null
      ? null
      : scopeThreadRef(environmentId, member.threadId),
  );
  const memberRevision = memberShell === null ? null : String(memberShell.updatedAt);
  const { refreshRows } = props;
  // oxlint-disable-next-line goat/react-effect-budget -- Read a member's tasks again when its conversation changes; the roster refreshes only the main bot's.
  useEffect(() => {
    if (memberRevision !== null) refreshRows();
  }, [memberRevision, refreshRows]);
  const now = useNowMinuteMs();
  const diagnostics = diagnoseGoatBot({
    home: home.resolution,
    homeLabel:
      homeId === null
        ? ""
        : (home.environments.find((entry) => entry.environmentId === homeId)?.label ??
          homeId.slice(0, 8)),
    moveTarget: home.moveTarget,
    member: member !== null,
    mainBotName: goatBotName(props.main ?? null),
    model: config
      ? goatBotModelStatus({
          settings: config.settings,
          providers: config.providers,
          ...(member === null ? {} : { override: member.defaultModelSelection }),
        })
      : null,
    canChangeModel: false,
    rows: rowsFromHome ? props.rows : "unavailable",
    turnsWaiting: rowsFromHome ? props.turnsWaiting : [],
    slack: !slackSupported ? "unavailable" : slack.error ? "failed" : (slack.data ?? "loading"),
    slackLive,
    canConfigureSlack: false,
    now,
  });
  if (props.quietWhenReady && !home.error && diagnostics.lines.every((line) => line.tone === "ok"))
    return null;
  return (
    <View
      accessibilityLabel={`${props.botName ?? "GOAT Bot"} status`}
      className={
        props.quietWhenReady
          ? "mt-2 mb-3 gap-2 rounded-2xl border border-border bg-grouped-card px-3 py-3"
          : "gap-2 border-b border-border pb-3"
      }
    >
      <Text className="font-semibold text-foreground">{diagnostics.title}</Text>
      {diagnostics.lines.map((line) => (
        <View key={line.key} className="flex-row flex-wrap items-center gap-2">
          <View className={`size-2 rounded-full ${TONE_DOT[line.tone]}`} />
          <Text className="flex-1 text-foreground">{line.text}</Text>
          {[line.action, line.alsoAction ?? null].map((action) =>
            action === null || (action.kind === "open_chat" && !props.onOpenChat) ? null : (
              <Pressable
                key={action.kind}
                accessibilityRole="button"
                disabled={action.kind === "claim_home" && home.busy}
                onPress={() => {
                  if (action.kind === "claim_home") home.changeHome(action.environmentId);
                  else if (action.kind === "open_chat") props.onOpenChat?.();
                  else if (action.kind === "open_task") props.onOpenTask(action.taskId);
                }}
                className="min-h-[44px] justify-center px-2"
              >
                <Text className="text-foreground">{action.label}</Text>
              </Pressable>
            ),
          )}
        </View>
      ))}
      {home.error ? <Text className="text-danger-foreground">{home.error}</Text> : null}
    </View>
  );
}
