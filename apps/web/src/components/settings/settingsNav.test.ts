import { describe, expect, it } from "vite-plus/test";

import { SETTINGS_NAV_GROUPS, SETTINGS_PAGE_LEADS } from "./settingsNav";
import {
  SETTINGS_SEARCH_ITEMS,
  SETTINGS_SECTION_LABELS,
  type SettingsPath,
} from "./settingsSearch";

const SIDEBAR_PAGES = (Object.keys(SETTINGS_SECTION_LABELS) as SettingsPath[]).filter(
  (path) => path !== "/settings/diagnostics",
);

describe("settings sidebar groups", () => {
  it("lists every settings page in exactly one group, so no page becomes unreachable", () => {
    const grouped = SETTINGS_NAV_GROUPS.flatMap((group) => group.paths);
    expect(grouped.toSorted()).toEqual(SIDEBAR_PAGES.toSorted());
  });

  it("links page leads only to sidebar pages and to anchors that settings search resolves", () => {
    const links = Object.values(SETTINGS_PAGE_LEADS).flatMap((lead) => lead?.related ?? []);
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(SIDEBAR_PAGES).toContain(link.to);
      if (link.hash) {
        expect(SETTINGS_SEARCH_ITEMS.find((item) => item.id === link.hash)?.to).toBe(link.to);
      }
    }
  });
});
