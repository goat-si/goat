import { msg } from "gt-react";
import type { SettingsSearchItem } from "./settingsSearch";

export const AGENT_SETTINGS_SEARCH_ITEMS = [
  {
    id: "mcp-servers",
    title: msg("MCP servers"),
    to: "/settings/integrations",
    scope: "environment-defaults",
    searchTerms: ["global mcp servers tools command stdio http headers environment"],
  },
  {
    id: "goat-skills",
    title: msg("GOAT skills"),
    to: "/settings/integrations",
    scope: "environment-defaults",
    searchTerms: ["global skills goat skill folder SKILL.md rescan remove disable"],
  },
  {
    id: "agent-workspace-access",
    title: msg("Agent workspace access"),
    to: "/settings/integrations",
    scope: "project-defaults",
    searchTerms: ["mcp files filesystem read write off project policy workspace"],
  },
  {
    id: "agent-terminal-access",
    title: msg("Agent terminal access"),
    to: "/settings/integrations",
    scope: "project-defaults",
    searchTerms: ["mcp shell terminal pty read operate off project policy sandbox"],
  },
  {
    id: "agent-browser-access",
    title: msg("Agent browser access"),
    to: "/settings/integrations",
    scope: "project-defaults",
    searchTerms: ["allow disable enable open drive preview tools sessions project override"],
  },
  {
    id: "agent-tool-listing",
    title: msg("GOAT tools agents see"),
    to: "/settings/integrations",
    scope: "environment-defaults",
    searchTerms: [
      "agent tool listing core all full mcp tools list describe call prompt context size",
    ],
  },
  {
    id: "goat-discipline-skill",
    title: msg("Development discipline"),
    to: "/settings/integrations",
    scope: "project-defaults",
    searchTerms: ["goat discipline skill built in code changes guidance inherit on off"],
  },
  {
    id: "goat-docs-skill",
    title: msg("GOAT Docs"),
    to: "/settings/integrations",
    scope: "project-defaults",
    searchTerms: [
      "goat docs skill built in user guides documentation answer questions inherit on off",
    ],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;
