import { useAtomValue } from "@effect/atom-react";
import { runAtomCommand, squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import type { EnvironmentId } from "@goat/contracts";
import { useState } from "react";
import { Text } from "react-native";

import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { appAtomRegistry } from "../../state/atom-registry";
import { channelEnvironment } from "../../state/channels";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { MobileBotProfileSheet } from "../goat-bot/MobileBotProfileSheet";
import { useMobileGoatBotHomeSettings } from "../goat-bot/useMobileGoatBotHomeSettings";
import { useMobileGoatBotModel } from "../goat-bot/useMobileGoatBotModel";
import { SettingsChoiceRow } from "./components/SettingsChoiceRow";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
/** The home belongs to the cluster, independent of the Settings environment filter. */
export function SettingsGoatBotRouteScreen() {
  const { supported, resolution, targets, environments, writableIds, busy, error, changeHome } =
    useMobileGoatBotHomeSettings();
  const claim = resolution.state === "claimed" ? resolution.claim : null;
  const label = (environmentId: EnvironmentId) =>
    environments.find((entry) => entry.environmentId === environmentId)?.label ?? environmentId;
  const status =
    resolution.state === "unknown"
      ? "Loading…"
      : claim === null
        ? "Not chosen yet"
        : resolution.state === "claimed" && !resolution.homeKnown
          ? `Not connected (${claim.environmentId.slice(0, 8)})`
          : resolution.state === "claimed" && !resolution.homeConnected
            ? `Waiting for ${label(claim.environmentId)}`
            : label(claim.environmentId);
  return (
    <SettingsScreen title="GOAT Bot">
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-4 px-5 pt-4 pb-8"
      >
        {!supported ? (
          <Text className="text-foreground-muted">
            Update a connected server to choose where GOAT Bot runs.
          </Text>
        ) : (
          <>
            {resolution.state === "claimed" && resolution.homeConnected ? (
              <GoatBotProfileSection
                key={"profile:" + resolution.claim.environmentId}
                environmentId={resolution.claim.environmentId}
              />
            ) : null}
            <Text className="text-foreground-muted">
              The computer where GOAT Bot answers and receives work.
            </Text>
            <Text accessibilityLiveRegion="polite" className="text-foreground">
              {busy ? "Saving…" : status}
            </Text>
            {error ? (
              <Text accessibilityRole="alert" className="text-danger-foreground">
                {error}
              </Text>
            ) : null}
            <SettingsSection title="Computers">
              {targets
                .filter((target) => target.supportsHome && target.supportsBot)
                .map((target) => (
                  <SettingsRow
                    key={target.environmentId}
                    icon="desktopcomputer"
                    label={label(target.environmentId)}
                    value={
                      target.environmentId === claim?.environmentId
                        ? "Current home"
                        : !target.connected
                          ? "Offline"
                          : !writableIds.has(target.environmentId)
                            ? "Permission required"
                            : undefined
                    }
                    disabled={
                      busy ||
                      resolution.state === "unknown" ||
                      !target.connected ||
                      !writableIds.has(target.environmentId)
                    }
                    onPress={() => changeHome(target.environmentId)}
                  />
                ))}
            </SettingsSection>
            {resolution.state === "claimed" && resolution.homeConnected ? (
              <GoatBotModelSection
                key={resolution.claim.environmentId}
                environmentId={resolution.claim.environmentId}
                canWrite={writableIds.has(resolution.claim.environmentId)}
              />
            ) : null}
          </>
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

/** The main bot's name, avatar and purpose on its home computer. */
function GoatBotProfileSection({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const { presentationById } = useEnvironments();
  const supported =
    presentationById.get(environmentId)?.serverConfig?.environment.capabilities
      .goatBotProfileEdit === true;
  const profiles = useEnvironmentQuery(
    supported ? channelEnvironment.listBots({ environmentId, input: {} }) : null,
  );
  const canEdit = useAtomValue(channelEnvironment.updateBot.permissionAtom(environmentId));
  const [editing, setEditing] = useState(false);
  if (!supported) return null;
  const main = profiles.data?.bots.find((bot) => bot.role === "main");
  return (
    <SettingsSection title="Profile">
      <SettingsRow
        icon="person.crop.circle"
        label={main === undefined ? "GOAT Bot" : [main.avatar, main.name].filter(Boolean).join(" ")}
        value={
          profiles.error
            ? "Couldn't load"
            : main === undefined
              ? "Not started yet"
              : canEdit
                ? "Edit"
                : "Permission required"
        }
        disabled={main === undefined || !canEdit}
        onPress={() => setEditing(true)}
      />
      {main?.purpose ? (
        <Text className="px-4 py-2 text-foreground-muted">{main.purpose}</Text>
      ) : null}
      {editing && main !== undefined ? (
        <MobileBotProfileSheet
          mode="edit"
          initial={main}
          canSubmit={canEdit}
          onClose={() => setEditing(false)}
          onSubmit={async (changes) => {
            const result = await runAtomCommand(appAtomRegistry, channelEnvironment.updateBot, {
              environmentId,
              input: { botId: main.botId, ...changes },
            });
            if (result._tag === "Success") return null;
            const failure = squashAtomCommandFailure(result);
            return failure instanceof Error ? failure.message : "Couldn't save the profile.";
          }}
        />
      ) : null}
    </SettingsSection>
  );
}

function GoatBotModelSection({
  environmentId,
  canWrite,
}: {
  readonly environmentId: EnvironmentId;
  readonly canWrite: boolean;
}) {
  const model = useMobileGoatBotModel(environmentId, canWrite);
  const [pickerOpen, setPickerOpen] = useState(false);
  if (!model) return null;
  const { state: modelState, settings, saving, error, allowed, save } = model;

  return (
    <>
      <SettingsSection title="Messages">
        <SettingsSwitchRow
          label="Answer with the bot session"
          subtitle="Use the bot session to understand and answer messages. Turn off to use reception first."
          value={settings.goatBotSessionRouting === "session"}
          disabled={!allowed}
          onValueChange={(value) =>
            save({ goatBotSessionRouting: value ? "session" : "reception" })
          }
        />
      </SettingsSection>
      <SettingsSection title="Workers">
        <SettingsSwitchRow
          label="Automatically choose a worker computer"
          subtitle="Use connected SSH computers with the same repository and model, based on quota and active work. Instructions, notes and named skills go to the selected computer."
          value={settings.channelAutoPlacement}
          disabled={!allowed}
          onValueChange={(value) => save({ channelAutoPlacement: value })}
        />
      </SettingsSection>
      <SettingsSection title="Model">
        <SettingsRow
          icon="sparkles"
          label="GOAT Bot model"
          value={saving ? "Saving…" : modelState.summaryLabel}
          disabled={!allowed}
          onPress={() => setPickerOpen((open) => !open)}
        />
        {pickerOpen ? (
          <>
            <SettingsChoiceRow
              label="Automatic"
              description={modelState.automaticDescription}
              selected={!modelState.separate}
              separated
              disabled={!allowed}
              onPress={() => {
                setPickerOpen(false);
                if (modelState.separate) save({ goatBotModelSelection: null });
              }}
            />
            {modelState.choices.map((choice) => (
              <SettingsChoiceRow
                key={choice.key}
                label={choice.label}
                description={choice.providerLabel}
                selected={
                  modelState.separate &&
                  modelState.selection.instanceId === choice.instanceId &&
                  modelState.selection.model === choice.model
                }
                separated
                disabled={!allowed}
                onPress={() => {
                  setPickerOpen(false);
                  if (
                    !modelState.separate ||
                    modelState.selection.instanceId !== choice.instanceId ||
                    modelState.selection.model !== choice.model
                  ) {
                    save({ goatBotModelSelection: choice.selection });
                  }
                }}
              />
            ))}
          </>
        ) : null}
      </SettingsSection>
      <Text className="text-foreground-muted">
        The model GOAT Bot uses when it looks into something itself. Automatic follows the default
        model for new threads.
      </Text>
      {error ? (
        <Text accessibilityRole="alert" className="text-danger-foreground">
          {error}
        </Text>
      ) : null}
    </>
  );
}
