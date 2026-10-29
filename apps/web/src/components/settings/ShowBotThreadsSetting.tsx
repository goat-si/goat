import { useShowBotThreads } from "../sidebar/useBotThreadKeys";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function ShowBotThreadsSetting() {
  const [shown, setShown] = useShowBotThreads();
  return (
    <SettingsRow
      {...searchableSetting("show-goat-bot-threads")}
      description="List the threads GOAT Bot runs to follow your work. Search finds them either way. Applies to this device."
      control={
        <Switch
          checked={shown}
          onCheckedChange={(checked) => setShown(Boolean(checked))}
          aria-label="Show GOAT Bot threads"
        />
      }
    />
  );
}
