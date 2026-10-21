import { useAtomValue } from "@effect/atom-react";
import { deriveGoatBotModelSettings } from "@goat/client-runtime/goatBot";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@goat/client-runtime/state/runtime";
import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  type RuntimeMode,
  type SlackChannelSettings as SlackConnection,
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
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { useEnvironmentProviders } from "~/state/environments";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection, SettingsUnavailableGroup } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
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

const failureMessage = (
  result: Parameters<typeof squashAtomCommandFailure>[0],
  fallback: string,
) => {
  const failure = squashAtomCommandFailure(result);
  return failure instanceof Error && failure.message.length > 0 ? failure.message : fallback;
};

/** Slack connection for the selected environment. Tokens stay on that server. */
export function SlackChannelSettings() {
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

  return (
    <SettingsSection id="slack-channel" title="Slack">
      {availability === "ready" && environmentId !== null ? (
        <SlackConnectionControls environmentId={environmentId} />
      ) : (
        <SettingsUnavailableGroup message={slackSettingsUnavailableMessage(availability)}>
          <SettingsRow
            {...searchableSetting("slack-connection")}
            description="Take @mentions and direct messages from Slack, and reply in the same thread."
          />
        </SettingsUnavailableGroup>
      )}
    </SettingsSection>
  );
}

function SlackConnectionControls({ environmentId }: { environmentId: EnvironmentId }) {
  const settingsQuery = useEnvironmentQuery(
    channelEnvironment.slackSettings({ environmentId, input: {} }),
  );
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
        {...searchableSetting("slack-connection")}
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
        onSaved={refreshSettings}
      />
    );
  }
  return connections.map((connection) => (
    <Fragment key={connection.connectionId}>
      <SlackConnectionForm
        environmentId={environmentId}
        connection={connection}
        onSaved={refreshSettings}
      />
      <SlackIdentityLinks environmentId={environmentId} connectionId={connection.connectionId} />
    </Fragment>
  ));
}

function SlackConnectionForm(props: {
  environmentId: EnvironmentId;
  connection: SlackConnection | undefined;
  onSaved: () => void;
}) {
  const { environmentId, connection } = props;
  const settings = useEnvironmentSettings(environmentId);
  const providers = useEnvironmentProviders().get(environmentId) ?? [];
  const reviewerChoices = deriveGoatBotModelSettings({ settings, providers }).choices;
  const configure = useAtomCommand(channelEnvironment.slackConfigure, { reportFailure: false });
  const disconnect = useAtomCommand(channelEnvironment.slackDisconnect, { reportFailure: false });
  const allProjects = useProjects();
  const projects = allProjects.filter((project) => project.environmentId === environmentId);
  // Untouched fields follow the latest saved settings; only the user's edits are kept locally.
  const [edits, setEdits] = useState<Partial<SlackSettingsDraft>>({});
  const draft: SlackSettingsDraft = { ...slackSettingsDraft(connection), ...edits };
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const update = (patch: Partial<SlackSettingsDraft>) => {
    setFormError(null);
    setEdits((current) => ({ ...current, ...patch }));
  };

  const save = async () => {
    const built = slackConfigureInput(draft, connection);
    if (built._tag === "invalid") {
      setFormError(built.message);
      return;
    }
    setBusy(true);
    const result = await configure({ environmentId, input: built.input });
    setBusy(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        setFormError(failureMessage(result, "Could not save the Slack settings."));
      }
      return;
    }
    // Saved values now come from the server; typed tokens are never shown again.
    setEdits({});
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
    props.onSaved();
  };

  const connectionError = slackConnectionErrorMessage(connection?.lastError);
  const deliveryError = slackDeliveryErrorMessage(connection?.lastDeliveryError);
  const selectedProject = projects.find((project) => project.id === draft.projectId);

  return (
    <>
      <SettingsRow
        {...searchableSetting("slack-connection")}
        description="Take @mentions and direct messages from Slack, and reply in the same thread."
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
            aria-label="Use Slack"
            checked={draft.enabled}
            disabled={busy}
            onCheckedChange={(checked) => update({ enabled: checked })}
          />
        }
      />
      <SettingsRow
        title="App-level token"
        description="Opens the Socket Mode connection. Needs connections:write."
        control={
          <Input
            size="sm"
            type="password"
            autoComplete="off"
            aria-label="Slack app-level token"
            placeholder={connection?.hasAppToken ? "Saved" : "xapp-…"}
            value={draft.appToken}
            disabled={busy}
            onChange={(event) => update({ appToken: event.target.value })}
          />
        }
      />
      <SettingsRow
        title="Bot token"
        description="Reads mentions and DMs and replies. Needs chat:write, app_mentions:read, im:history."
        control={
          <Input
            size="sm"
            type="password"
            autoComplete="off"
            aria-label="Slack bot token"
            placeholder={connection?.hasBotToken ? "Saved" : "xoxb-…"}
            value={draft.botToken}
            disabled={busy}
            onChange={(event) => update({ botToken: event.target.value })}
          />
        }
      />
      <SettingsRow
        title="Channels"
        description="Channel IDs where mentions start work, separated by commas. DMs always work."
        control={
          <Input
            size="sm"
            aria-label="Allowed Slack channel IDs"
            placeholder="C0123456789"
            value={draft.channels}
            disabled={busy}
            onChange={(event) => update({ channels: event.target.value })}
          />
        }
      />
      <SettingsRow
        title="Default project"
        description="Where work from Slack runs when the request doesn't say."
        control={
          <Select
            disabled={busy}
            value={draft.projectId.length > 0 ? draft.projectId : NO_PROJECT}
            onValueChange={(value) =>
              update({ projectId: value === null || value === NO_PROJECT ? "" : value })
            }
          >
            <SelectTrigger size="sm" aria-label="Default project for Slack work">
              <SelectValue>{selectedProject?.title ?? "Ask each time"}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value={NO_PROJECT}>Ask each time</SelectItem>
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
        title="Independent review"
        description="Review successful work before reporting it done. Choose the reviewer for this Slack connection."
        control={
          <Switch
            aria-label="Independent review for Slack work"
            checked={draft.reviewEnabled === true}
            disabled={busy}
            onCheckedChange={(checked) => update({ reviewEnabled: checked })}
          />
        }
      />
      <SettingsRow
        title="Reviewer model"
        description="The selected model reviews in a separate thread. Unavailable or failed reviews are reported explicitly."
        control={
          <Select
            disabled={busy}
            value={
              reviewerChoices.find(
                (choice) =>
                  choice.instanceId === draft.reviewerModel?.instanceId &&
                  choice.model === draft.reviewerModel.model,
              )?.key ?? ""
            }
            onValueChange={(key) => {
              const choice = reviewerChoices.find((candidate) => candidate.key === key);
              if (choice) update({ reviewerModel: choice.selection });
            }}
          >
            <SelectTrigger size="sm" aria-label="Slack reviewer model">
              <SelectValue>{draft.reviewerModel?.model ?? "Choose a model"}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {reviewerChoices.map((choice) => (
                <SelectItem key={choice.key} value={choice.key}>
                  {choice.providerLabel} · {choice.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title="Save"
        description={formError ?? "Leave a token empty to keep the saved one."}
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
                  Delete tokens
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || !connection.enabled}
                  onClick={() => void turnOff()}
                >
                  Disconnect
                </Button>
              </>
            )}
            <Button size="sm" disabled={busy} onClick={() => void save()}>
              Save
            </Button>
          </div>
        }
      />
    </>
  );
}

const RUNTIME_MODE_LABELS: Record<RuntimeMode, string> = {
  "approval-required": "Ask before changes",
  "auto-accept-edits": "Accept edits",
  auto: "Auto",
  "full-access": "Full access",
};

/** One-time codes that link a Slack user to this server's owner, and unlinking. */
function SlackIdentityLinks(props: { environmentId: EnvironmentId; connectionId: string }) {
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
          title: "No link code",
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
          title: "Not unlinked",
          description: failureMessage(result, "Could not unlink that Slack user."),
        });
      }
      return;
    }
    setSlackUserId("");
    toastManager.add({ type: "success", title: "Slack user unlinked" });
  };

  return (
    <>
      <SettingsRow
        title="Link your Slack account"
        description={
          code === null
            ? "Create a one-time code, then send it to the bot in a DM. Work you start from Slack is capped at this level."
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
              <SelectTrigger size="sm" aria-label="Access for linked Slack account">
                <SelectValue>{RUNTIME_MODE_LABELS[ceiling]}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {(Object.keys(RUNTIME_MODE_LABELS) as RuntimeMode[]).map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {RUNTIME_MODE_LABELS[mode]}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void create()}>
              Create code
            </Button>
          </div>
        }
      />
      <SettingsRow
        title="Unlink a Slack user"
        description="Tasks already started keep the requester they were created with."
        control={
          <div className="flex items-center gap-2">
            <Input
              size="sm"
              aria-label="Slack user ID to unlink"
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
              Unlink
            </Button>
          </div>
        }
      />
    </>
  );
}
