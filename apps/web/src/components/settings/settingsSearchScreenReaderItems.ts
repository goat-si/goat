import type { SettingsSearchItem } from "./settingsSearch";

export const SCREEN_READER_SETTINGS_SEARCH_ITEMS = [
  {
    id: "working-shelf",
    title: "Working section",
    to: "/settings/beta",
    searchTerms: ["beta hide fold running monitoring threads inbox sidebar shelf"],
  },
  {
    id: "screen-reader-announcements",
    title: "Screen reader announcements",
    to: "/settings/general",
    searchTerms: [
      "accessibility a11y screen reader nvda jaws voiceover orca narrator speech announce read aloud messages activity steps",
    ],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;
