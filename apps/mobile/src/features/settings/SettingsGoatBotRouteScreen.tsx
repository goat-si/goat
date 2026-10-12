import type { EnvironmentId, GoatBotHomeClaim } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { Text } from "react-native";

import { ScreenScrollView } from "../../components/ScreenScrollView";
import { uuidv4 } from "../../lib/uuid";
import { useMobileGoatBotHomeSettings } from "../goat-bot/useMobileGoatBotHomeSettings";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import {
  planMobileGoatBotHomeChange,
  writeMobileGoatBotHomeChange,
} from "./mobileGoatBotHomeChange";

/** The home belongs to the cluster, independent of the Settings environment filter. */
export function SettingsGoatBotRouteScreen() {
  const { supported, resolution, targets, environments, writableIds, write } =
    useMobileGoatBotHomeSettings();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const observedMax = useRef<GoatBotHomeClaim | null>(null);
  const claim = resolution.state === "claimed" ? resolution.claim : null;
  const label = (environmentId: EnvironmentId) =>
    environments.find((entry) => entry.environmentId === environmentId)?.label ?? environmentId;
  const status =
    resolution.state === "unknown"
      ? "Loading…"
      : claim === null
        ? "Not chosen yet"
        : resolution.state === "claimed" && !resolution.homeConnected
          ? `Waiting for ${label(claim.environmentId)}`
          : label(claim.environmentId);
  function changeHome(environmentId: EnvironmentId) {
    if (busy || resolution.state === "unknown") return;
    const change = planMobileGoatBotHomeChange({
      environmentId,
      targets,
      writableIds,
      currentClaim: claim,
      observedMax: observedMax.current,
      // oxlint-disable-next-line react/purity -- The row invokes this callback on user selection.
      now: Date.now(),
      randomId: uuidv4,
    });
    if (change === null) return;
    observedMax.current = change.claim;
    setBusy(true);
    setError(null);
    void writeMobileGoatBotHomeChange(change, write)
      .then((success) => {
        if (!success) setError("Could not save on every computer. Reconnect to sync the choice.");
      })
      .finally(() => setBusy(false));
  }
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
          </>
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}
