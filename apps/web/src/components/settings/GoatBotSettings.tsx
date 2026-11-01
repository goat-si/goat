import { useGoatBotHomeSettings } from "../goatBot/useGoatBotHome";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { GoatBotModelSettings } from "./GoatBotModelSettings";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

/** The bot's cluster-wide home, independent of the settings page's selected environment. */
export function GoatBotSettings() {
  const { supported, resolution, targets, environments, writableIds, busy, error, changeHome } =
    useGoatBotHomeSettings();
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
        : resolution.state === "claimed" && !resolution.homeKnown
          ? `Not connected (${claim.environmentId.slice(0, 8)})`
          : resolution.state === "claimed" && !resolution.homeConnected
            ? `Waiting for ${label(claim.environmentId)}`
            : label(claim.environmentId);
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
            onValueChange={(value) => {
              const target = options.find((entry) => entry.environmentId === value);
              if (target) changeHome(target.environmentId);
            }}
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
      <GoatBotModelSettings />
    </SettingsSection>
  );
}
