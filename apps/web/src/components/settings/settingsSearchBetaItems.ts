import type { SettingsSearchItem } from "./settingsSearch";

export const BETA_SETTINGS_SEARCH_ITEMS = [
  {
    id: "new-design",
    title: "New design",
    to: "/settings/beta",
    searchTerms: ["beta redesign look style sidebar composer black quieter classic"],
  },
  {
    id: "working-shelf",
    title: "Working section",
    to: "/settings/beta",
    searchTerms: ["beta hide fold running monitoring threads inbox sidebar shelf"],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;
