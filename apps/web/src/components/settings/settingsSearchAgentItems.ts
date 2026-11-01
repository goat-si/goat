import type { SettingsSearchItem } from "./settingsSearch";

export const AGENT_SETTINGS_SEARCH_ITEMS = [
  {
    id: "agent-workspace-access",
    title: "Agent workspace access",
    to: "/settings/integrations",
    scope: "project-defaults",
    searchTerms: ["mcp files filesystem read write off project policy workspace"],
  },
  {
    id: "agent-terminal-access",
    title: "Agent terminal access",
    to: "/settings/integrations",
    scope: "project-defaults",
    searchTerms: ["mcp shell terminal pty read operate off project policy sandbox"],
  },
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
  {
    id: "goat-docs-skill",
    title: "GOAT Docs",
    to: "/settings/integrations",
    scope: "project-defaults",
    searchTerms: [
      "goat docs skill built in user guides documentation answer questions inherit on off",
    ],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;
