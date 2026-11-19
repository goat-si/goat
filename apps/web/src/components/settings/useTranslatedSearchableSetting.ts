import { useMessages } from "gt-react";
import { searchableSetting, type SettingsSearchItemId } from "./settingsSearch";

/** Row anchor props with the registry title in the active language. */
export function useTranslatedSearchableSetting() {
  const m = useMessages();
  return (id: SettingsSearchItemId) => {
    const setting = searchableSetting(id);
    return { ...setting, title: m(setting.title) };
  };
}
