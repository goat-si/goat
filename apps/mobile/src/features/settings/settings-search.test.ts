import { describe, expect, it, vi } from "vite-plus/test";
import { isGoatConnectEnabled } from "@goat/shared/goatConnect";

import { filterSettingsSections } from "./settings-search";

vi.mock("@goat/shared/goatConnect", async (importOriginal) => {
  const original = await importOriginal<typeof import("@goat/shared/goatConnect")>();
  return { ...original, isGoatConnectEnabled: vi.fn(original.isGoatConnectEnabled) };
});

const SECTIONS = [
  { rows: [{ id: "usage", label: "Usage" }] },
  {
    title: "Connections",
    rows: [
      { id: "account", label: "GOAT Account" },
      { id: "SettingsEnvironments", label: "Environments" },
    ],
  },
  {
    title: "Interface",
    rows: [
      { id: "SettingsAppearance", label: "Appearance" },
      { id: "SettingsKeyboard", label: "Keyboard" },
    ],
  },
  {
    title: "Server settings",
    rows: [
      { id: "SettingsProviderAccounts", label: "Provider accounts" },
      { id: "SettingsEnvironmentSourceControl", label: "Source control" },
    ],
  },
];

function visible(query: string) {
  return filterSettingsSections(SECTIONS, query).map((section) => [
    section.title ?? null,
    section.rows.map((row) => row.label),
  ]);
}

describe("filterSettingsSections", () => {
  it.each([false, true])("finds Hub consent only when Connect is enabled: %s", (enabled) => {
    vi.mocked(isGoatConnectEnabled).mockReturnValue(enabled);
    try {
      const hubSections = [{ rows: [{ id: "SettingsHubNodes", label: "Hub devices" }] }];
      for (const query of ["connect", "access", "grant", "revoke"]) {
        expect(filterSettingsSections(hubSections, query).length > 0).toBe(enabled);
      }
      expect(filterSettingsSections(hubSections, "hub devices")).toEqual(hubSections);
    } finally {
      vi.mocked(isGoatConnectEnabled).mockReset();
    }
  });

  it.each([
    {
      query: "",
      expected: SECTIONS.map((section) => [
        section.title ?? null,
        section.rows.map((row) => row.label),
      ]),
    },
    { query: "   ", expected: visible("") },
    { query: "appear", expected: [["Interface", ["Appearance"]]] },
    { query: "KEYBOARD", expected: [["Interface", ["Keyboard"]]] },
    { query: "dark mode", expected: [["Interface", ["Appearance"]]] },
    { query: "branch naming", expected: [["Server settings", ["Source control"]]] },
    {
      query: "server settings",
      expected: [["Server settings", ["Provider accounts", "Source control"]]],
    },
    {
      query: "accounts",
      expected: [["Server settings", ["Provider accounts"]]],
    },
    { query: "usage", expected: [[null, ["Usage"]]] },
    { query: "zzzz", expected: [] },
  ])("$query", ({ query, expected }) => {
    expect(visible(query)).toEqual(expected);
  });

  it("drops sections that start empty", () => {
    expect(filterSettingsSections([{ rows: [] }, ...SECTIONS], "").length).toBe(SECTIONS.length);
  });
});
