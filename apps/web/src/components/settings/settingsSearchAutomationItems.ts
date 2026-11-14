import type { SettingsSearchItem } from "./settingsSearch";

export const AUTOMATION_SETTINGS_SEARCH_ITEMS = [
  {
    id: "scheduled-tasks",
    title: "Scheduled tasks",
    to: "/settings/scheduled-tasks",
  },
  {
    id: "goat-bot-home",
    title: "Runs on",
    to: "/settings/goat-bot",
    targetId: "goat-bot",
    searchTerms: ["goat bot home computer environment cluster"],
  },
] as const satisfies readonly SettingsSearchItem[];
