// Seam for v1 apps/web/src/components/settings/useTranslatedSearchableSetting.ts (goat 916b5ccc1b2): GOAT 2 is English
// first (owner rule), so titles are returned as registered.
import { searchableSetting, type SettingsSearchItemId } from "./settingsSearch";

export function useTranslatedSearchableSetting() {
  return (id: SettingsSearchItemId) => searchableSetting(id);
}
