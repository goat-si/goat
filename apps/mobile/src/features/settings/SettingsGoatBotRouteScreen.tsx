import type { EnvironmentId } from "@goat/contracts";
import { useState } from "react";
import { Text } from "react-native";

import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { useMobileGoatBotHomeSettings } from "../goat-bot/useMobileGoatBotHomeSettings";
import { useMobileGoatBotModel } from "../goat-bot/useMobileGoatBotModel";
import { SettingsChoiceRow } from "./components/SettingsChoiceRow";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SlackReviewSettings } from "./SlackReviewSettings";
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
              <SlackReviewSettings environmentId={resolution.claim.environmentId} />
            ) : null}
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
