import type { SettingsSearchItem } from "./settingsSearch";

export const AGENT_SETTINGS_SEARCH_ITEMS = [
  {
    id: "agent-browser-access",
    title: "Agent browser access",
    to: "/settings/integrations",
    scope: "project-defaults",
    searchTerms: ["allow disable enable open drive preview tools sessions project override"],
  },
  {
    id: "agent-tool-listing",
    title: "GOAT tools agents see",
    to: "/settings/integrations",
    scope: "environment-defaults",
    searchTerms: [
      "agent tool listing core all full mcp tools list describe call prompt context size",
    ],
  },
  {
    id: "goat-discipline-skill",
    title: "Development discipline",
    to: "/settings/integrations",
    scope: "project-defaults",
    searchTerms: ["goat discipline skill built in code changes guidance inherit on off"],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;
