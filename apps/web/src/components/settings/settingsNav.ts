import type { SettingsPath } from "./settingsSearch";

export interface SettingsNavGroup {
  readonly label: string;
  readonly paths: ReadonlyArray<SettingsPath>;
}

/** Diagnostics stays out of the sidebar; General links to it. */
export const SETTINGS_NAV_GROUPS: ReadonlyArray<SettingsNavGroup> = [
  {
    label: "App",
    paths: [
      "/settings/general",
      "/settings/appearance",
      "/settings/keybindings",
      "/settings/snap-shot",
    ],
  },
  {
    label: "Agents",
    paths: [
      "/settings/providers",
      "/settings/memory",
      "/settings/integrations",
      "/settings/source-control",
    ],
  },
  {
    label: "Projects & threads",
    paths: ["/settings/projects", "/settings/storage", "/settings/archived"],
  },
  {
    label: "Automations",
    paths: ["/settings/goat-bot", "/settings/decision-inbox", "/settings/scheduled-tasks"],
  },
  {
    label: "Machines",
    paths: ["/settings/hub", "/settings/connections"],
  },
];

export interface SettingsPageLink {
  readonly label: string;
  readonly to: SettingsPath;
  readonly hash?: string;
}

export interface SettingsPageLead {
  readonly text: string;
  readonly related?: ReadonlyArray<SettingsPageLink>;
}

/**
 * One line at the top of each page saying what it holds. "Hub" names one thing everywhere: the
 * GOAT server phones pair with, which also runs the fleet and whose OpenCodex is the Home.
 */
export const SETTINGS_PAGE_LEADS: Readonly<Partial<Record<SettingsPath, SettingsPageLead>>> = {
  "/settings/general": {
    text: "Defaults for new threads, notifications, updates, and how GOAT behaves day to day.",
  },
  "/settings/appearance": { text: "Theme, fonts, and layout of this app on this device." },
  "/settings/keybindings": { text: "Keyboard shortcuts for this app." },
  "/settings/snap-shot": { text: "Capture part of your screen and attach it to a thread." },
  "/settings/providers": {
    text: "The coding agents GOAT runs, with their accounts and models. Codex can send its model requests through OpenCodex Home, the hub's OpenCodex that keeps every sign-in.",
    related: [{ label: "Hub", to: "/settings/hub" }],
  },
  "/settings/memory": { text: "What agents remember across threads, and who can read it." },
  "/settings/integrations": {
    text: "Tools agents can use besides your code: the browser, GOAT tools, simulators, and computer use.",
  },
  "/settings/source-control": {
    text: "Git, pull requests, GitHub accounts, and the text agents write for commits and reviews.",
  },
  "/settings/projects": { text: "Settings for the selected project." },
  "/settings/storage": {
    text: "Where worktrees live, when they are cleaned up, and artifacts and logs.",
  },
  "/settings/archived": { text: "Threads you archived. Restore or delete them here." },
  "/settings/goat-bot": {
    text: "GOAT Bot answers your messages and starts work for you. Runs on picks the environment it lives on, which can differ from the hub.",
  },
  "/settings/decision-inbox": {
    text: "Questions agents left for you, each with a recommendation and a deadline.",
  },
  "/settings/scheduled-tasks": { text: "Prompts that run on a schedule." },
  "/settings/hub": {
    text: "The hub is the GOAT server your phone pairs with. It checks your other devices, holds cloud runs, and its OpenCodex is the OpenCodex Home that keeps every sign-in. Make only one environment the hub.",
    related: [
      { label: "Connect your phone", to: "/settings/connections", hash: "hub-device" },
      { label: "OpenCodex Home for Codex", to: "/settings/providers" },
    ],
  },
  "/settings/connections": {
    text: "How this app reaches your environments, and how phones, browsers, and agents reach this one.",
    related: [{ label: "Hub", to: "/settings/hub" }],
  },
};
