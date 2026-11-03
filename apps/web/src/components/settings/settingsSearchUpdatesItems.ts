import type { SettingsSearchItem } from "./settingsSearch";
export const UPDATES_SETTINGS_SEARCH_ITEMS = [
  {
    id: "provider-update-checks",
    title: "Provider update checks",
    to: "/settings/general",
    searchTerms: ["installed cli versions newer available codex claude cursor grok fx opencode"],
    scope: "environment-defaults",
  },
  {
    id: "automatic-server-updates",
    title: "Automatic server updates",
    to: "/settings/general",
    scope: "environment-defaults",
    searchTerms: ["background service stable nightly channel idle automatic update"],
  },
  {
    id: "continue-threads-after-server-update",
    title: "Continue threads after restarts",
    to: "/settings/general",
    scope: "project-defaults",
    searchTerms: [
      "resume running active interrupted work restart reboot machine crash desktop update automatically",
    ],
  },
  {
    id: "background-activity",
    title: "Background activity",
    to: "/settings/general",
    scope: "environment-defaults",
    searchTerms: [
      "balanced performance battery saver advanced git fetch provider health refresh host power monitor idle policy",
    ],
  },
  {
    id: "agent-memory-limit",
    title: "Agent memory limit",
    to: "/settings/general",
    scope: "environment-defaults",
    searchTerms: ["macos memory ram oom process kill automatic gib"],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;
