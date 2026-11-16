import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { BotProfile, EnvironmentId } from "@goat/contracts";
import { useContext, useState } from "react";
import { Text } from "react-native";

import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { channelEnvironment } from "../../state/channels";
import { useEnvironments } from "../../state/environments";
import { environmentPresentations } from "../../state/presentation";
import { useEnvironmentQuery } from "../../state/query";
import { MobileBotProfileSheet } from "../goat-bot/MobileBotProfileSheet";
import {
  isComputerReadable,
  useComputerReadable,
  useComputerStartingOver,
  useKeptPerComputer,
} from "../goat-bot/useKeptPerComputer";
import { useMobileBotManage } from "../goat-bot/useMobileBotManage";
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
            {resolution.state === "claimed" && resolution.homeKnown ? (
              <GoatBotProfileSection
                key={"profile:" + resolution.claim.environmentId}
                environmentId={resolution.claim.environmentId}
                connected={resolution.homeConnected}
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
            {resolution.state === "claimed" && resolution.homeKnown ? (
              <GoatBotModelSection
                key={resolution.claim.environmentId}
                environmentId={resolution.claim.environmentId}
                computer={label(resolution.claim.environmentId)}
                connected={resolution.homeConnected}
                canWrite={writableIds.has(resolution.claim.environmentId)}
              />
            ) : null}
          </>
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

/**
 * The main bot's name, avatar and purpose on its home computer. Offline it shows what the roster
 * last read there and stays closed; refused or removed, it shows nothing from that computer.
 */
function GoatBotProfileSection({
  environmentId,
  connected,
}: {
  readonly environmentId: EnvironmentId;
  readonly connected: boolean;
}) {
  const registry = useContext(RegistryContext);
  const { presentationById } = useEnvironments();
  const capabilities = presentationById.get(environmentId)?.serverConfig?.environment.capabilities;
  const supported = capabilities?.goatBotProfileEdit === true;
  // The roster's exact read, so both share one request and one kept answer.
  const profiles = useEnvironmentQuery(
    supported && connected
      ? channelEnvironment.listBots({
          environmentId,
          input: capabilities?.goatBotMembers === true ? { includeDeleted: true } : {},
        })
      : null,
  );
  const listed = useKeptPerComputer("bots", environmentId, profiles, !connected);
  const readable = useComputerReadable(environmentId);
  const startingOver = useComputerStartingOver(environmentId);
  const mayEdit = useAtomValue(channelEnvironment.updateBot.permissionAtom(environmentId));
  const main = listed?.bots.find((bot) => bot.role === "main");
  const manage = useMobileBotManage(environmentId, main?.name);
  // The sheet holds the bot's profile, so a list read again on reconnect keeps it open; it closes
  // for good once this computer may not be read.
  const [editing, setEditing] = useState<BotProfile | null>(null);
  if (editing !== null && !readable) setEditing(null);
  if (!supported) return null;
  // Starting over, a refusal being asked again is still loading; one that stands is not.
  const loadFailed = startingOver
    ? profiles.error !== null && !profiles.isPending
    : !readable || profiles.error !== null;
  return (
    <SettingsSection title="Profile">
      <SettingsRow
        icon="person.crop.circle"
        label={main === undefined ? "GOAT Bot" : [main.avatar, main.name].filter(Boolean).join(" ")}
        value={
          loadFailed
            ? "Couldn't load"
            : !connected
              ? "Offline"
              : main === undefined
                ? listed == null
                  ? "Loading…"
                  : "Not started yet"
                : mayEdit
                  ? "Edit"
                  : "Permission required"
        }
        disabled={main === undefined || !manage.canEdit}
        onPress={() => setEditing(main ?? null)}
      />
      {main?.purpose ? (
        <Text className="px-4 py-2 text-foreground-muted">{main.purpose}</Text>
      ) : null}
      {editing !== null ? (
        <MobileBotProfileSheet
          mode="edit"
          initial={editing}
          canSubmit={manage.canEdit}
          unavailableReason={manage.connected ? undefined : manage.offlineReason}
          onClose={() => setEditing(null)}
          // Save reads the store when pressed: a refusal not yet rendered sends nothing.
          onSubmit={(changes) =>
            isComputerReadable(registry, environmentId)
              ? manage.update(editing, changes)
              : Promise.resolve(null)
          }
        />
      ) : null}
    </SettingsSection>
  );
}

/**
 * Messages, Workers and Model on the home computer, shown only while this phone may read it, the
 * same check as Profile, connected or not. Offline they keep the config last loaded from it and
 * stay closed to changes; refused or removed, they show none of it, and while a fresh bot list is
 * asked after that they read as loading.
 */
function GoatBotModelSection({
  environmentId,
  computer,
  connected,
  canWrite,
}: {
  readonly environmentId: EnvironmentId;
  readonly computer: string;
  readonly connected: boolean;
  readonly canWrite: boolean;
}) {
  const registry = useContext(RegistryContext);
  const model = useMobileGoatBotModel(environmentId, canWrite);
  const readable = useComputerReadable(environmentId);
  const startingOver = useComputerStartingOver(environmentId);
  const { presentationById } = useEnvironments();
  const capabilities = presentationById.get(environmentId)?.serverConfig?.environment.capabilities;
  // The roster's read; started over, it decides whether the fresh list failed or is still asked.
  const list = useEnvironmentQuery(
    startingOver && connected && capabilities?.goatBotProfiles === true
      ? channelEnvironment.listBots({
          environmentId,
          input: capabilities.goatBotMembers === true ? { includeDeleted: true } : {},
        })
      : null,
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  if (pickerOpen && !(connected && readable)) setPickerOpen(false);
  if (!readable || !model) {
    // Connected, the config is still loading.
    if (readable && connected) return null;
    const pending = readable || (startingOver && !(list.error !== null && !list.isPending));
    return (
      <>
        <Text className="text-foreground-muted">
          {!pending
            ? `Couldn't load these settings from ${computer}.`
            : connected
              ? "Loading…"
              : `Shown when ${computer} connects.`}
        </Text>
        {["Messages", "Workers", "Model"].map((title) => (
          <SettingsSection key={title} title={title}>
            {null}
          </SettingsSection>
        ))}
      </>
    );
  }
  const { state: modelState, settings, saving, error } = model;
  const allowed = model.allowed && connected;
  // Read when pressed: a refusal or a drop not yet rendered saves nothing.
  const save = (patch: Parameters<typeof model.save>[0]) => {
    const live = registry.get(environmentPresentations.presentationsAtom).get(environmentId);
    if (live?.connection.phase === "connected" && isComputerReadable(registry, environmentId))
      void model.save(patch);
  };

  return (
    <>
      {connected ? null : (
        <Text className="text-foreground-muted">{`Changes need ${computer} connected.`}</Text>
      )}
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
