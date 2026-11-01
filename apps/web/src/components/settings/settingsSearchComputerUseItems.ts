import type { SettingsSearchItem } from "./settingsSearch";

export const COMPUTER_USE_SETTINGS_SEARCH_ITEMS = [
  {
    id: "computer-use",
    title: "Computer use",
    to: "/settings/integrations",
    targetId: "computer",
    searchTerms: [
      "cua driver apps desktop screen click type agents control mac linux windows accessibility screen recording permissions setup set up retry full access approval without asking every app",
    ],
  },
  {
    id: "computer-use-move-pointer",
    title: "Let agents move my pointer",
    to: "/settings/integrations",
    searchTerms: [
      "computer use pointer mouse cursor move foreground background click steal focus advanced",
    ],
  },
  {
    id: "computer-use-strict-input-guards",
    title: "Strict input guards",
    to: "/settings/integrations",
    searchTerms: ["computer use input guards confirmations advanced"],
  },
  {
    id: "computer-use-skill",
    title: "Computer Use skill",
    to: "/settings/integrations",
    searchTerms: [
      "built in builtin skill computer use instructions agents observe verify advanced readiness",
    ],
  },
  {
    id: "screen-code-skill",
    title: "Screen Code skill",
    to: "/settings/integrations",
    searchTerms: [
      "built in builtin skill screen code cells browser tab desktop target instructions agents advanced",
    ],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;
