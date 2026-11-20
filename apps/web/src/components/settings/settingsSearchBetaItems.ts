import { msg } from "gt-react";

import type { SettingsSearchItem } from "./settingsSearch";

export const BETA_SETTINGS_SEARCH_ITEMS = [
  {
    id: "new-design",
    title: msg("New design"),
    to: "/settings/beta",
    searchTerms: ["beta redesign look style sidebar composer black quieter classic"],
  },
  {
    id: "working-shelf",
    title: msg("Working section"),
    to: "/settings/beta",
    searchTerms: ["beta hide fold running monitoring threads inbox sidebar shelf"],
  },
  {
    id: "tool-call-visibility",
    title: msg("Tool calls in chat"),
    to: "/settings/beta",
    searchTerms: [
      "beta labs hide tool calls commands edits searches work log activity quiet chat zen final answers only",
    ],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;
