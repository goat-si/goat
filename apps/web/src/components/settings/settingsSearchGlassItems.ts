import type { SettingsSearchItem } from "./settingsSearch";

export const GLASS_SETTINGS_SEARCH_ITEMS = [
  {
    // Prefixed because the slider control already owns the `glass-opacity` id.
    id: "setting-glass-opacity",
    title: "Glass opacity",
    to: "/settings/appearance",
    searchTerms: ["transparent transparency solid menus dialogs composer"],
  },
  {
    id: "desktop-system-material",
    title: "System glass",
    to: "/settings/appearance",
    searchTerms: ["native transparency mica windows accessibility"],
    desktopOnly: true,
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;
