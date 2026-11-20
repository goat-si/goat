import { msg } from "gt-react";
import type { SettingsSearchItem } from "./settingsSearch";

export const BROWSER_SETTINGS_SEARCH_ITEMS = [
  {
    id: "browser-profiles",
    title: msg("Browser profiles"),
    to: "/settings/integrations",
    targetId: "browser",
  },
  {
    id: "browser-default-profile",
    title: msg("Default browser profile"),
    to: "/settings/integrations",
    targetId: "browser-profiles",
  },
  {
    id: "browser-default-viewport",
    title: msg("Default browser viewport"),
    to: "/settings/integrations",
    searchTerms: ["preview size width height device desktop mobile rotate"],
  },
  {
    id: "browser-default-zoom",
    title: msg("Default browser zoom"),
    to: "/settings/integrations",
    searchTerms: ["preview page scale tabs percent"],
  },
  {
    id: "browser-default-appearance",
    title: msg("Default browser appearance"),
    to: "/settings/integrations",
    searchTerms: ["preview color scheme light dark system os"],
  },
  {
    id: "browser-recording-frame-rate",
    title: msg("Browser recording frame rate"),
    to: "/settings/integrations",
  },
  {
    id: "browser-recording-key-presses",
    title: msg("Show key presses in recordings"),
    to: "/settings/integrations",
    searchTerms: ["browser preview keyboard shortcuts keystrokes overlay capture"],
  },
  {
    id: "browser-recording-mouse-presses",
    title: msg("Show mouse presses in recordings"),
    to: "/settings/integrations",
    searchTerms: ["browser preview clicks buttons drag overlay capture"],
  },
  {
    id: "browser-link-target",
    title: msg("Open links in"),
    to: "/settings/integrations",
    searchTerms: ["links default browser in-app browser external open"],
  },
  {
    id: "browser-search-engine",
    title: msg("Search engine"),
    to: "/settings/integrations",
    searchTerms: ["address bar duckduckgo google bing brave kagi ecosia custom"],
  },
  {
    id: "pull-request-links-open-in-app",
    title: msg("Open pull requests in GOAT"),
    to: "/settings/integrations",
    searchTerms: ["pr links github browser external click default pull request view panel"],
  },
  {
    id: "browser-auto-show-floating-preview",
    title: msg("Auto-show floating preview"),
    to: "/settings/integrations",
    searchTerms: ["agent opens browser device simulator pop into view hide"],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;
