import {
  diagnoseGoatBot,
  goatBotModelStatus,
  type GoatBotDiagnosticTone,
  type GoatBotDiagnosticsInput,
} from "@goat/client-runtime/goatBot";
import type { BotProfile, ChannelTaskId, EnvironmentId } from "@goat/contracts";
import { Pressable, Text, View } from "react-native";

import { useNowMinuteMs } from "../../lib/clock";
import { channelEnvironment } from "../../state/channels";
import { useEnvironmentServerConfig } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useMobileGoatBotHomeSettings } from "./useMobileGoatBotHomeSettings";

const TONE_DOT: Record<GoatBotDiagnosticTone, string> = {
  ok: "bg-adaptive-emerald-600-400",
  pending: "bg-foreground-muted",
  warn: "bg-warning",
  error: "bg-danger",
};

/**
 * Whether the bot can work now, and why not, at the top of the Work sheet. Mobile has no model or
 * Slack settings screens, so it only offers moving the home and opening a waiting task.
 */
export function MobileBotStatusCard(props: {
  readonly environmentId: EnvironmentId | null;
  readonly member: { readonly defaultModelSelection: BotProfile["defaultModelSelection"] } | null;
  readonly rows: GoatBotDiagnosticsInput["rows"];
  readonly onOpenTask: (taskId: ChannelTaskId) => void;
}) {
  const { environmentId, member } = props;
  const home = useMobileGoatBotHomeSettings();
  const config = useEnvironmentServerConfig(environmentId);
  const { presentationById } = useEnvironments();
  const presentation = environmentId === null ? undefined : presentationById.get(environmentId);
  const slack = useEnvironmentQuery(
    member === null &&
      environmentId !== null &&
      presentation?.connection.phase === "connected" &&
      presentation.serverConfig?.environment.capabilities.slackChannel === true
      ? channelEnvironment.slackSettings({ environmentId, input: {} })
      : null,
  );
  const now = useNowMinuteMs();
  const homeId = home.resolution.state === "claimed" ? home.resolution.claim.environmentId : null;
  const diagnostics = diagnoseGoatBot({
    home: home.resolution,
    homeLabel:
      homeId === null
        ? ""
        : (home.environments.find((entry) => entry.environmentId === homeId)?.label ??
          homeId.slice(0, 8)),
    moveTarget: home.moveTarget,
    member: member !== null,
    model: config
      ? goatBotModelStatus({
          settings: config.settings,
          providers: config.providers,
          ...(member === null ? {} : { override: member.defaultModelSelection }),
        })
      : null,
    canChangeModel: false,
    rows: props.rows,
    slack: slack.data ?? null,
    canConfigureSlack: false,
    now,
  });
  return (
    <View accessibilityLabel="GOAT Bot status" className="gap-2 border-b border-border pb-3">
      <Text className="font-semibold text-foreground">{diagnostics.title}</Text>
      {diagnostics.lines.map((line) => (
        <View key={line.key} className="flex-row flex-wrap items-center gap-2">
          <View className={`size-2 rounded-full ${TONE_DOT[line.tone]}`} />
          <Text className="flex-1 text-foreground">{line.text}</Text>
          {line.action?.kind === "claim_home" ? (
            <Pressable
              accessibilityRole="button"
              disabled={home.busy}
              onPress={() => {
                if (line.action?.kind === "claim_home") home.changeHome(line.action.environmentId);
              }}
              className="min-h-[44px] justify-center px-2"
            >
              <Text className="text-foreground">{line.action.label}</Text>
            </Pressable>
          ) : line.action?.kind === "open_task" ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                if (line.action?.kind === "open_task") props.onOpenTask(line.action.taskId);
              }}
              className="min-h-[44px] justify-center px-2"
            >
              <Text className="text-foreground">{line.action.label}</Text>
            </Pressable>
          ) : null}
        </View>
      ))}
      {home.error ? <Text className="text-danger-foreground">{home.error}</Text> : null}
    </View>
  );
}
