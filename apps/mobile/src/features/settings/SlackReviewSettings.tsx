import { useAtomValue } from "@effect/atom-react";
import { deriveGoatBotModelSettings } from "@goat/client-runtime/goatBot";
import type {
  EnvironmentId,
  SlackChannelSettings,
  SlackChannelReviewSettings,
} from "@goat/contracts";
import { useState } from "react";
import { Text } from "react-native";

import { channelEnvironment } from "../../state/channels";
import { useEnvironmentServerConfig } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsChoiceRow } from "./components/SettingsChoiceRow";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";

export function SlackReviewSettings({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const config = useEnvironmentServerConfig(environmentId);
  const query = useEnvironmentQuery(channelEnvironment.slackSettings({ environmentId, input: {} }));
  if (!config?.environment.capabilities.slackChannel) return null;
  return (
    <>
      {query.data?.map((connection) => (
        <SlackReviewConnection
          key={connection.connectionId}
          environmentId={environmentId}
          connection={connection}
          refresh={query.refresh}
        />
      ))}
    </>
  );
}

function SlackReviewConnection({
  environmentId,
  connection,
  refresh,
}: {
  readonly environmentId: EnvironmentId;
  readonly connection: SlackChannelSettings;
  readonly refresh: () => void;
}) {
  const config = useEnvironmentServerConfig(environmentId);
  const canConfigure = useAtomValue(
    channelEnvironment.slackConfigure.permissionAtom(environmentId),
  );
  const configure = useAtomCommand(channelEnvironment.slackConfigure, {
    label: "Slack independent review",
    reportFailure: false,
  });
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!config) return null;
  const choices = deriveGoatBotModelSettings({
    settings: config.settings,
    providers: config.providers,
  }).choices;
  const selected = connection.review;
  async function save(review: SlackChannelReviewSettings) {
    if (busy || !canConfigure) return;
    setBusy(true);
    setError(null);
    try {
      const result = await configure({
        environmentId,
        input: {
          connectionId: connection.connectionId,
          enabled: connection.enabled,
          review,
        },
      });
      if (result._tag === "Success") {
        refresh();
        setOpen(false);
      } else setError("Could not save Slack review settings.");
    } catch {
      setError("Could not save Slack review settings.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <SettingsSection title={"Slack review · " + (connection.teamId ?? connection.connectionId)}>
      <SettingsRow
        icon="sparkles"
        label="Independent review"
        value={selected?.enabled ? selected.modelSelection.model : "Off"}
        disabled={busy || !canConfigure}
        onPress={() => setOpen((value) => !value)}
      />
      {open ? (
        <>
          {selected ? (
            <SettingsChoiceRow
              label="Off"
              selected={!selected.enabled}
              disabled={busy || !canConfigure}
              onPress={() => void save({ ...selected, enabled: false })}
            />
          ) : null}
          {choices.map((choice) => (
            <SettingsChoiceRow
              key={choice.key}
              label={choice.label}
              description={choice.providerLabel}
              selected={
                selected?.enabled === true &&
                selected.modelSelection.instanceId === choice.instanceId &&
                selected.modelSelection.model === choice.model
              }
              disabled={busy || !canConfigure}
              onPress={() => void save({ enabled: true, modelSelection: choice.selection })}
            />
          ))}
          <Text className="text-foreground-muted">
            The selected model reviews successful Slack work in a separate thread before completion.
          </Text>
        </>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" className="text-danger-foreground">
          {error}
        </Text>
      ) : null}
    </SettingsSection>
  );
}
