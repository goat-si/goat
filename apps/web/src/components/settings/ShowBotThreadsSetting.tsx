import { useGT } from "gt-react";
import { useShowBotThreads } from "../sidebar/useBotThreadKeys";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";
import { useTranslatedSearchableSetting } from "./useTranslatedSearchableSetting";

export function ShowBotThreadsSetting() {
  const setting = useTranslatedSearchableSetting();
  const gt = useGT();
  const [shown, setShown] = useShowBotThreads();
  return (
    <SettingsRow
      {...setting("show-goat-bot-threads")}
      description={gt(
        "List bot conversations and the work bots keep under their tasks. Search finds them either way. Applies to this device.",
      )}
      control={
        <Switch
          checked={shown}
          onCheckedChange={(checked) => setShown(Boolean(checked))}
          aria-label={gt("Show GOAT Bot threads")}
        />
      }
    />
  );
}
