import { useAtomValue } from "@effect/atom-react";
import {
  diagnoseGoatBot,
  goatBotModelStatus,
  type GoatBotDiagnosticAction,
  type GoatBotDiagnosticTone,
  type GoatBotDiagnosticsInput,
  type GoatBotWaitingTurn,
} from "@goat/client-runtime/goatBot";
import {
  AuthSettingsWriteScope,
  type BotProfile,
  type EnvironmentId,
  type ServerSettings,
  type SlackChannelStatusEvent,
} from "@goat/contracts";
import { Link } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect } from "react";

import { useNowMinute } from "~/hooks/useNowMinute";
import { cn } from "~/lib/utils";
import { channelEnvironment } from "~/state/channels";
import { useEnvironment, useEnvironmentProviders } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useEnvironmentScope } from "~/state/session";
import { Button } from "../ui/button";
import { goatBotSearch, useGoatBotMainName, useGoatBotName } from "./goatBotMemberContext";
import { useGoatBotHomeSettings } from "./useGoatBotHome";
import { GoatBotSectionCard } from "./GoatBotSectionCard";

const NO_PERMISSION = Atom.make(false);
const NO_SETTINGS = Atom.make<ServerSettings | null>(null);
const NO_SLACK_EVENT = Atom.make<AsyncResult.AsyncResult<SlackChannelStatusEvent, unknown>>(
  AsyncResult.initial(),
);

const TONE_DOT: Record<GoatBotDiagnosticTone, string> = {
  ok: "bg-success",
  pending: "bg-muted-foreground",
  warn: "bg-warning",
  error: "bg-destructive",
};

/**
 * Whether the bot (main, or the given member) can work now, and why not. Reads only what this
 * client already holds for the bot's home; `rows` come from the caller's own task list.
 */
export function GoatBotStatusCard({
  environmentId: callerEnvironmentId,
  member,
  rows,
  turnsWaiting,
  onShowChat,
  className,
  botName,
  quietWhenReady = false,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly member: BotProfile | null;
  readonly rows: GoatBotDiagnosticsInput["rows"];
  readonly turnsWaiting: ReadonlyArray<GoatBotWaitingTurn>;
  /** Called when a link leads back to the chat, so a sheet over it can close. */
  readonly onShowChat?: (() => void) | undefined;
  readonly className?: string;
  /** The bot this card describes. Settings passes the main bot; a chat uses the open one. */
  readonly botName?: string;
  /** Show nothing while every line is fine, as the bot's home does. */
  readonly quietWhenReady?: boolean;
}) {
  const openName = useGoatBotName();
  const mainBotName = useGoatBotMainName();
  const name = botName ?? openName;
  const home = useGoatBotHomeSettings();
  const homeId = home.resolution.state === "claimed" ? home.resolution.claim.environmentId : null;
  // Read at the home the card names, never at another machine the caller happens to show.
  const environmentId = homeId ?? callerEnvironmentId;
  const presentation = useEnvironment(environmentId);
  const settings = useAtomValue(
    environmentId === null ? NO_SETTINGS : serverEnvironment.settingsValueAtom(environmentId),
  );
  const providersByEnvironment = useEnvironmentProviders();
  const providers = environmentId === null ? undefined : providersByEnvironment.get(environmentId);
  const canChangeModel = useAtomValue(
    environmentId === null
      ? NO_PERMISSION
      : serverEnvironment.updateSettings.permissionAtom(environmentId),
  );
  const canConfigureSlack = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
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
  const now = Date.parse(`${useNowMinute()}:00Z`);
  const diagnostics = diagnoseGoatBot({
    home: home.resolution,
    homeLabel:
      homeId === null
        ? ""
        : (home.environments.find((entry) => entry.environmentId === homeId)?.label ??
          homeId.slice(0, 8)),
    moveTarget: home.moveTarget,
    member: member !== null,
    mainBotName,
    model:
      settings === null || providers === undefined
        ? null
        : goatBotModelStatus({
            settings,
            providers,
            ...(member === null ? {} : { override: member.defaultModelSelection }),
          }),
    canChangeModel,
    rows: homeId === null || homeId === callerEnvironmentId ? rows : "unavailable",
    turnsWaiting: homeId === null || homeId === callerEnvironmentId ? turnsWaiting : [],
    slack: !slackSupported ? "unavailable" : slack.error ? "failed" : (slack.data ?? "loading"),
    slackLive,
    canConfigureSlack,
    now,
  });
  if (quietWhenReady && diagnostics.lines.every((line) => line.tone === "ok")) return null;
  const content = (
    <section aria-label={`${name} status`} className={cn("space-y-2 text-sm", className)}>
      <p className="font-semibold">{diagnostics.title}</p>
      <ul className="space-y-1.5">
        {diagnostics.lines.map((line) => (
          <li key={line.key} className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span aria-hidden className={cn("size-2 shrink-0 rounded-full", TONE_DOT[line.tone])} />
            <span className="min-w-0 flex-1">{line.text}</span>
            {[line.action, line.alsoAction ?? null].map((action) =>
              action === null ? null : (
                <StatusAction
                  key={action.kind}
                  action={action}
                  member={member}
                  busy={home.busy}
                  onClaim={home.changeHome}
                  onShowChat={onShowChat}
                />
              ),
            )}
          </li>
        ))}
      </ul>
      {home.error ? <p className="text-xs text-destructive-foreground">{home.error}</p> : null}
    </section>
  );
  return quietWhenReady ? (
    <GoatBotSectionCard title="Status">
      <div className="px-3 py-3">{content}</div>
    </GoatBotSectionCard>
  ) : (
    content
  );
}

function StatusAction({
  action,
  member,
  busy,
  onClaim,
  onShowChat,
}: {
  readonly action: GoatBotDiagnosticAction;
  readonly member: BotProfile | null;
  readonly busy: boolean;
  readonly onClaim: (environmentId: EnvironmentId) => void;
  readonly onShowChat: (() => void) | undefined;
}) {
  switch (action.kind) {
    case "claim_home":
      return (
        <Button
          size="compact"
          variant="outline"
          disabled={busy}
          onClick={() => onClaim(action.environmentId)}
        >
          {action.label}
        </Button>
      );
    case "open_task":
      return (
        <Button
          size="compact"
          variant="outline"
          render={<Link to="/bot" search={{ task: action.taskId, ...goatBotSearch(member) }} />}
        >
          {action.label}
        </Button>
      );
    case "open_chat":
      return (
        <Button
          size="compact"
          variant="outline"
          render={<Link to="/bot" search={goatBotSearch(member)} onClick={onShowChat} />}
        >
          {action.label}
        </Button>
      );
    case "choose_model":
    case "open_slack_settings":
      return (
        <Button
          size="compact"
          variant="outline"
          render={
            <Link
              to="/settings/goat-bot"
              search={{ machine: action.environmentId }}
              hash={action.kind === "choose_model" ? "goat-bot" : "slack-channel"}
            />
          }
        >
          {action.label}
        </Button>
      );
  }
}
