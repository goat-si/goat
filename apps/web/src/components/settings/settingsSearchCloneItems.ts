import type { SettingsSearchItem } from "./settingsSearch";

export const CLONE_SETTINGS_SEARCH_ITEMS = [
  {
    id: "add-project-starts-in",
    title: "Add project starts in",
    to: "/settings/general",
    scope: "environment-defaults",
    searchTerms: ["base directory folder browser path home"],
  },
  {
    id: "ghq-clone-layout",
    title: "Clone into host folders",
    to: "/settings/general",
    scope: "environment-defaults",
    searchTerms: ["ghq clone destination host owner repository root layout"],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;
