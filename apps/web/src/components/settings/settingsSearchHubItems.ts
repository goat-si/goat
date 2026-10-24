import type { SettingsSearchItem } from "./settingsSearch";

/** Settings → Hub. Old names stay in searchTerms so earlier labels still find them. */
export const HUB_SETTINGS_SEARCH_ITEMS = [
  {
    id: "hub-enabled",
    title: "This machine is the hub",
    to: "/settings/hub",
    searchTerms: [
      "hub goatclaw opencodex home fleet parity remote link",
      "main machine phone pairs server",
    ],
  },
  {
    id: "hub-cloud-holder",
    title: "Cloud runs",
    to: "/settings/hub",
    searchTerms: ["cloud holder claude cloud cursor cloud devin cloud hub"],
  },
  {
    id: "hub-permission-profiles",
    title: "Permission profiles",
    to: "/settings/hub",
    searchTerms: ["goatclaw permission profiles supervisor agents capabilities limits"],
  },
  {
    id: "hub-default-profile",
    title: "Default profile",
    to: "/settings/hub",
    searchTerms: ["goatclaw default permission profile worker manager owner observer"],
  },
  {
    id: "hub-devices",
    title: "OpenCodex devices",
    to: "/settings/hub",
    searchTerms: [
      "hub devices",
      "devices parity verify fallback sign-in hub down remote link child hub client opencodex",
      "add device join leave remove disconnect repair relink",
    ],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;
