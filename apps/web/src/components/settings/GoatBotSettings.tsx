// @effect-diagnostics cryptoRandomUUID:off - browser home claims use the platform UUID source.
import { newGoatBotHomeClaim } from "@goat/client-runtime/goatBot/home";
import { useState } from "react";

import { useGoatBotHomeSettings } from "../goatBot/useGoatBotHome";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

/** The bot's cluster-wide home, independent of the settings page's selected environment. */
export function GoatBotSettings() {
  const { supported, resolution, targets, environments, writableIds, write } =
    useGoatBotHomeSettings();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!supported) return null;
  const options = targets.filter(
    (target) => target.connected && target.supportsHome && target.supportsBot,
  );
  const claim = resolution.state === "claimed" ? resolution.claim : null;
  const label = (id: string) =>
    environments.find((entry) => entry.environmentId === id)?.label ?? id;
  const valueLabel =
    resolution.state === "unknown"
      ? "Loading…"
      : claim === null
        ? "Not chosen yet"
        : resolution.state === "claimed" && !resolution.homeConnected
          ? `Waiting for ${label(claim.environmentId)}`
          : label(claim.environmentId);
  function changeHome(value: string | null) {
    const target = options.find((entry) => entry.environmentId === value);
    if (!target || !writableIds.has(target.environmentId) || value === claim?.environmentId) return;
    const next = newGoatBotHomeClaim({
      environmentId: target.environmentId,
      // oxlint-disable-next-line react/purity -- Select invokes this callback on user selection.
      now: Date.now(),
      observedMax: claim,
      randomId: () => crypto.randomUUID(),
    });
    setBusy(true);
    setError(null);
    void Promise.all(
      targets
        .filter(
          (entry) => entry.connected && entry.supportsHome && writableIds.has(entry.environmentId),
        )
        .map((entry) => write(entry.environmentId, next)),
    )
      .then((results) => {
        if (results.some((success) => !success))
          setError("Could not save on every computer. Reconnect to sync the choice.");
      })
      .finally(() => setBusy(false));
  }
  return (
    <SettingsSection id="goat-bot" title="GOAT Bot">
      <SettingsRow
        {...searchableSetting("goat-bot-home")}
        description="The computer where GOAT Bot answers and receives work."
        status={error}
        control={
          <Select
            value={claim?.environmentId ?? null}
            disabled={
              busy ||
              resolution.state === "unknown" ||
              !options.some((target) => writableIds.has(target.environmentId))
            }
            onValueChange={changeHome}
          >
            <SelectTrigger size="sm" aria-label="GOAT Bot runs on">
              <SelectValue>{valueLabel}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {options.map((target) => (
                <SelectItem
                  key={target.environmentId}
                  value={target.environmentId}
                  disabled={!writableIds.has(target.environmentId)}
                >
                  {label(target.environmentId)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
    </SettingsSection>
  );
}
