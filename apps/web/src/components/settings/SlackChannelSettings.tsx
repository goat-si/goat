import { useTranslatedSearchableSetting } from "./useTranslatedSearchableSetting";
import { useGT, msg, useMessages } from "gt-react";
import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@goat/client-runtime/state/runtime";
import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  type RuntimeMode,
  type BotProfile,
  type SlackBotBindings,
  type SlackChannelScope,
  type SlackChannelSettings as SlackConnection,
  type SlackUserAccess,
} from "@goat/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { Fragment, useEffect, useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { channelEnvironment } from "~/state/channels";
import { useProjects } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection, SettingsUnavailableGroup } from "./settingsLayout";
import { SlackBotBindingEditor } from "./SlackBotBindingEditor";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  type SlackSettingsDraft,
  slackConfigureInput,
  slackConnectionErrorMessage,
  slackDeliveryErrorMessage,
  slackSettingsAvailability,
  slackSettingsDraft,
  slackSettingsUnavailableMessage,
  slackStatusLabel,
  withLiveStatus,
} from "./SlackChannelSettings.logic";

const NO_PROJECT = "__none__";

const CHANNEL_SCOPE_LABELS: Record<SlackChannelScope, string> = {
  all: msg("Every channel it's in"),
  listed: msg("These channels only"),
};

const USER_ACCESS_LABELS: Record<SlackUserAccess, string> = {
  workspace: msg("Everyone in the workspace"),
  linked: msg("Linked accounts only"),
};

const failureMessage = (
  result: Parameters<typeof squashAtomCommandFailure>[0],
  fallback: string,
) => {
  const failure = squashAtomCommandFailure(result);
  return failure instanceof Error && failure.message.length > 0 ? failure.message : fallback;
};

/** Slack connection for the selected environment. Tokens stay on that server. */
export function SlackChannelSettings() {
  const gt = useGT();
  const localizedSetting = useTranslatedSearchableSetting();
  const { environment: selected } = useSettingsScope();
  const connected = selected?.connection.phase === "connected" && selected.serverConfig !== null;
  const environmentId = connected ? selected.environmentId : null;
  const canConfigure = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const availability = slackSettingsAvailability({
    environmentSelected: selected !== null,
    connected,
    slackChannel: selected?.serverConfig?.environment.capabilities.slackChannel,
    canConfigure,
  });

  const unavailableMessage = slackSettingsUnavailableMessage(availability);

  return (
    <SettingsSection id="slack-channel" title="Slack">
      {availability === "ready" && environmentId !== null ? (
        <SlackConnectionControls
          environmentId={environmentId}
          bindingChoices={
            selected?.serverConfig?.environment.capabilities.slackBotBindings === true
          }
          accessChoices={
            selected?.serverConfig?.environment.capabilities.slackChannelAccess === true
          }
        />
      ) : (
        <SettingsUnavailableGroup
          message={unavailableMessage === undefined ? undefined : gt(unavailableMessage)}
        >
          <SettingsRow
            {...localizedSetting("slack-connection")}
            description={gt(
              "Take @mentions and direct messages from Slack, and reply in the same thread.",
            )}
          />
        </SettingsUnavailableGroup>
      )}
    </SettingsSection>
  );
}

function SlackConnectionControls({
  environmentId,
  accessChoices,
  bindingChoices,
}: {
  environmentId: EnvironmentId;
  accessChoices: boolean;
  bindingChoices: boolean;
}) {
  const localizedSetting = useTranslatedSearchableSetting();
  const settingsQuery = useEnvironmentQuery(
    channelEnvironment.slackSettings({ environmentId, input: {} }),
  );
  const roster = useEnvironmentQuery(
    bindingChoices ? channelEnvironment.listBots({ environmentId, input: {} }) : null,
  );
  const bindingBots = bindingChoices
    ? (roster.data?.bots ?? []).filter(
        (bot) => bot.role === "member" && bot.state !== "deleted" && bot.hidden !== true,
      )
    : null;
  const statusResult = useAtomValue(channelEnvironment.slackStatus({ environmentId, input: {} }));
  const liveStatus = Option.getOrNull(AsyncResult.value(statusResult));
  const refreshSettings = settingsQuery.refresh;
  // The stream carries one connection's change at a time; re-read the snapshot so every
  // connection shows its current status, not only the one that changed last.
  useEffect(() => {
    if (liveStatus !== null) refreshSettings();
  }, [liveStatus, refreshSettings]);

  if (settingsQuery.data === null) {
    return (
      <SettingsRow
        {...localizedSetting("slack-connection")}
        description={settingsQuery.error ?? "Loading Slack settings…"}
      />
    );
  }
  const connections = settingsQuery.data.map((stored) => withLiveStatus(stored, liveStatus));
  if (connections.length === 0) {
    return (
      <SlackConnectionForm
        environmentId={environmentId}
        connection={undefined}
        accessChoices={accessChoices}
        bindingBots={bindingBots}
        onSaved={refreshSettings}
      />
    );
  }
  return connections.map((connection) => (
    <Fragment key={connection.connectionId}>
      <SlackConnectionForm
        environmentId={environmentId}
        connection={connection}
        accessChoices={accessChoices}
        bindingBots={bindingBots}
        onSaved={refreshSettings}
      />
      <SlackIdentityLinks environmentId={environmentId} connectionId={connection.connectionId} />
    </Fragment>
  ));
}

function SlackConnectionForm(props: {
  environmentId: EnvironmentId;
  connection: SlackConnection | undefined;
  /** The server's slackChannelAccess capability. */
  accessChoices: boolean;
  bindingBots: ReadonlyArray<BotProfile> | null;
  onSaved: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const localizedSetting = useTranslatedSearchableSetting();
  const { environmentId, connection } = props;
  const configure = useAtomCommand(channelEnvironment.slackConfigure, { reportFailure: false });
  const disconnect = useAtomCommand(channelEnvironment.slackDisconnect, { reportFailure: false });
  const allProjects = useProjects();
  const projects = allProjects.filter((project) => project.environmentId === environmentId);
  // Untouched fields follow the latest saved settings; only the user's edits are kept locally.
  const [edits, setEdits] = useState<Partial<SlackSettingsDraft>>({});
  const [bindingEdits, setBindingEdits] = useState<SlackBotBindings>();
  const { accessChoices, bindingBots } = props;
  const draft: SlackSettingsDraft = { ...slackSettingsDraft(connection, accessChoices), ...edits };
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const update = (patch: Partial<SlackSettingsDraft>) => {
    setFormError(null);
    setEdits((current) => ({ ...current, ...patch }));
  };

  const save = async () => {
    const built = slackConfigureInput(draft, connection, accessChoices);
    if (built._tag === "invalid") {
      setFormError(built.message);
      return;
    }
    setBusy(true);
    const result = await configure({
      environmentId,
      input: {
        ...built.input,
        ...(bindingBots === null || bindingEdits === undefined
          ? {}
          : { botBindings: bindingEdits }),
      },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        setFormError(failureMessage(result, "Could not save the Slack settings."));
      }
      return;
    }
    // Saved values now come from the server; typed tokens are never shown again.
    setEdits({});
    setBindingEdits(undefined);
    props.onSaved();
  };

  const turnOff = async () => {
    if (connection === undefined) return;
    setBusy(true);
    const result = await disconnect({
      environmentId,
      input: { connectionId: connection.connectionId },
    });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      setFormError(failureMessage(result, "Could not disconnect Slack."));
      return;
    }
    setEdits({});
    setBindingEdits(undefined);
    props.onSaved();
  };

  const removeTokens = async () => {
    if (connection === undefined) return;
    const confirmed = await requestConfirmDialog(
      "Disconnect Slack and delete both tokens from this server?",
    );
    if (confirmed !== true) return;
    setBusy(true);
    const result = await configure({
      environmentId,
      input: {
        connectionId: connection.connectionId,
        enabled: false,
        clearCredentials: true,
      },
    });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      setFormError(failureMessage(result, "Could not delete the Slack tokens."));
      return;
    }
    setEdits({});
    setBindingEdits(undefined);
    props.onSaved();
  };

  const connectionError = slackConnectionErrorMessage(connection?.lastError);
  const deliveryError = slackDeliveryErrorMessage(connection?.lastDeliveryError);
  const selectedProject = projects.find((project) => project.id === draft.projectId);

  return (
    <>
      <SettingsRow
        {...localizedSetting("slack-connection")}
        description={gt(
          "Take @mentions and direct messages from Slack, and reply in the same thread.",
        )}
        status={
          connection === undefined ? null : (
            <span>
              {slackStatusLabel(connection.status)}
              {connection.teamId === undefined ? "" : ` · workspace ${connection.teamId}`}
              {connection.botUserId === undefined ? "" : ` · bot ${connection.botUserId}`}
              {connectionError === undefined ? "" : ` · ${connectionError}`}
              {deliveryError === undefined ? "" : ` · ${deliveryError}`}
            </span>
          )
        }
        control={
          <Switch
            aria-label={gt("Use Slack")}
            checked={draft.enabled}
            disabled={busy}
            onCheckedChange={(checked) => update({ enabled: checked })}
          />
        }
      />
      <SettingsRow
        title={gt("App-level token")}
        description={gt("Opens the Socket Mode connection. Needs connections:write.")}
        control={
          <Input
            size="sm"
            type="password"
            autoComplete="off"
            aria-label={gt("Slack app-level token")}
            placeholder={connection?.hasAppToken ? gt("Saved") : "xapp-…"}
            value={draft.appToken}
            disabled={busy}
            onChange={(event) => update({ appToken: event.target.value })}
          />
        }
      />
      <SettingsRow
        title={gt("Bot token")}
        description={gt(
          "Reads mentions and DMs and replies. Needs chat:write, app_mentions:read, im:history.",
        )}
        control={
          <Input
            size="sm"
            type="password"
            autoComplete="off"
            aria-label={gt("Slack bot token")}
            placeholder={connection?.hasBotToken ? gt("Saved") : "xoxb-…"}
            value={draft.botToken}
            disabled={busy}
            onChange={(event) => update({ botToken: event.target.value })}
          />
        }
      />
      <SettingsRow
        title={gt("Channels")}
        description={
          accessChoices
            ? gt(
                "Invite the bot to a channel before mentioning it there; it can't hear channels it isn't in. DMs always work.",
              )
            : gt("Update GOAT on this machine to answer in every channel or without a link.")
        }
        control={
          <Select
            disabled={busy || !accessChoices}
            value={draft.channelScope}
            onValueChange={(value) => {
              if (value !== null) update({ channelScope: value as SlackChannelScope });
            }}
          >
            <SelectTrigger size="sm" aria-label={gt("Slack channels the bot answers in")}>
              <SelectValue>{m(CHANNEL_SCOPE_LABELS[draft.channelScope])}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {(Object.keys(CHANNEL_SCOPE_LABELS) as SlackChannelScope[]).map((scope) => (
                <SelectItem key={scope} value={scope}>
                  {m(CHANNEL_SCOPE_LABELS[scope])}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      {draft.channelScope === "listed" ? (
        <SettingsRow
          title={gt("Channel IDs")}
          description={gt("Separated by commas. Find an ID under the channel's details.")}
          control={
            <Input
              size="sm"
              aria-label={gt("Allowed Slack channel IDs")}
              placeholder="C0123456789"
              value={draft.channels}
              disabled={busy}
              onChange={(event) => update({ channels: event.target.value })}
            />
          }
        />
      ) : null}
      {bindingBots === null ? null : (
        <SlackBotBindingEditor
          bindings={bindingEdits ?? connection?.botBindings ?? []}
          bots={bindingBots}
          disabled={busy}
          onChange={setBindingEdits}
        />
      )}
      <SettingsRow
        title={gt("Who can use it")}
        description={
          draft.userAccess === "workspace"
            ? gt("People who haven't linked an account work at the level below.")
            : gt("Others get a reply explaining how to link.")
        }
        control={
          <Select
            disabled={busy || !accessChoices}
            value={draft.userAccess}
            onValueChange={(value) => {
              if (value !== null) update({ userAccess: value as SlackUserAccess });
            }}
          >
            <SelectTrigger size="sm" aria-label={gt("Who can use the Slack bot")}>
              <SelectValue>{m(USER_ACCESS_LABELS[draft.userAccess])}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {(Object.keys(USER_ACCESS_LABELS) as SlackUserAccess[]).map((access) => (
                <SelectItem key={access} value={access}>
                  {m(USER_ACCESS_LABELS[access])}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      {draft.userAccess === "workspace" ? (
        <SettingsRow
          title={gt("Access without a link")}
          description={gt("The most work started by someone without a linked account may do.")}
          control={
            <Select
              disabled={busy}
              value={draft.unlinkedRuntimeModeCeiling}
              onValueChange={(value) => {
                if (value !== null) update({ unlinkedRuntimeModeCeiling: value as RuntimeMode });
              }}
            >
              <SelectTrigger size="sm" aria-label={gt("Access for Slack users without a link")}>
                <SelectValue>
                  {m(RUNTIME_MODE_LABELS[draft.unlinkedRuntimeModeCeiling])}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {(Object.keys(RUNTIME_MODE_LABELS) as RuntimeMode[]).map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {m(RUNTIME_MODE_LABELS[mode])}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
      ) : null}
      <SettingsRow
        title={gt("Default project")}
        description={gt("Where work from Slack runs when the request doesn't say.")}
        control={
          <Select
            disabled={busy}
            value={draft.projectId.length > 0 ? draft.projectId : NO_PROJECT}
            onValueChange={(value) =>
              update({ projectId: value === null || value === NO_PROJECT ? "" : value })
            }
          >
            <SelectTrigger size="sm" aria-label={gt("Default project for Slack work")}>
              <SelectValue>{selectedProject?.title ?? gt("Ask each time")}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value={NO_PROJECT}>{gt("Ask each time")}</SelectItem>
              {projects.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.title}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title={gt("Save")}
        description={formError ?? gt("Leave a token empty to keep the saved one.")}
        control={
          <div className="flex items-center gap-2">
            {connection === undefined ? null : (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void removeTokens()}
                >
                  {gt("Delete tokens")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || !connection.enabled}
                  onClick={() => void turnOff()}
                >
                  {gt("Disconnect")}
                </Button>
              </>
            )}
            <Button size="sm" disabled={busy} onClick={() => void save()}>
              {gt("Save")}
            </Button>
          </div>
        }
      />
    </>
  );
}

const RUNTIME_MODE_LABELS: Record<RuntimeMode, string> = {
  "approval-required": msg("Ask before changes"),
  "auto-accept-edits": msg("Accept edits"),
  auto: msg("Auto"),
  "full-access": msg("Full access"),
};

/** One-time codes that link a Slack user to this server's owner, and unlinking. */
function SlackIdentityLinks(props: { environmentId: EnvironmentId; connectionId: string }) {
  const gt = useGT();
  const m = useMessages();
  const { environmentId, connectionId } = props;
  const createLink = useAtomCommand(channelEnvironment.createIdentityLink, {
    reportFailure: false,
  });
  const unlink = useAtomCommand(channelEnvironment.unlinkIdentity, { reportFailure: false });
  const [ceiling, setCeiling] = useState<RuntimeMode>("approval-required");
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [slackUserId, setSlackUserId] = useState("");
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    const result = await createLink({
      environmentId,
      input: { connectionId, runtimeModeCeiling: ceiling },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add({
          type: "error",
          title: gt("No link code"),
          description: failureMessage(result, "Could not create a link code."),
        });
      }
      return;
    }
    setCode(result.value);
  };

  const removeLink = async () => {
    const externalActorId = slackUserId.trim().toUpperCase();
    if (externalActorId.length === 0) return;
    setBusy(true);
    const result = await unlink({ environmentId, input: { connectionId, externalActorId } });
    setBusy(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add({
          type: "error",
          title: gt("Not unlinked"),
          description: failureMessage(result, "Could not unlink that Slack user."),
        });
      }
      return;
    }
    setSlackUserId("");
    toastManager.add({ type: "success", title: gt("Slack user unlinked") });
  };

  return (
    <>
      <SettingsRow
        title={gt("Link your Slack account")}
        description={
          code === null
            ? gt(
                "Create a one-time code, then send it to the bot in a DM. Work you start from Slack is capped at this level.",
              )
            : `Send "link ${code.code}" to the bot in a DM before ${new Date(code.expiresAt).toLocaleTimeString()}.`
        }
        control={
          <div className="flex items-center gap-2">
            <Select
              value={ceiling}
              onValueChange={(value) => {
                if (value !== null) setCeiling(value as RuntimeMode);
              }}
            >
              <SelectTrigger size="sm" aria-label={gt("Access for linked Slack account")}>
                <SelectValue>{m(RUNTIME_MODE_LABELS[ceiling])}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {(Object.keys(RUNTIME_MODE_LABELS) as RuntimeMode[]).map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {m(RUNTIME_MODE_LABELS[mode])}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void create()}>
              {gt("Create code")}
            </Button>
          </div>
        }
      />
      <SettingsRow
        title={gt("Unlink a Slack user")}
        description={gt("Tasks already started keep the requester they were created with.")}
        control={
          <div className="flex items-center gap-2">
            <Input
              size="sm"
              aria-label={gt("Slack user ID to unlink")}
              placeholder="U0123456789"
              value={slackUserId}
              disabled={busy}
              onChange={(event) => setSlackUserId(event.target.value)}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={busy || slackUserId.trim().length === 0}
              onClick={() => void removeLink()}
            >
              {gt("Unlink")}
            </Button>
          </div>
        }
      />
    </>
  );
}
