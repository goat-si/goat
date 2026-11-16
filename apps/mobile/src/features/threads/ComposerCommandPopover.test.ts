import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  Pressable: () => null,
  ScrollView: () => null,
  StyleSheet: { hairlineWidth: 1 },
  View: () => null,
}));
vi.mock("expo-image", () => ({ Image: () => null }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/AppText", () => ({ AppText: () => null }));
vi.mock("../../components/ui/GlassSurface", () => ({ GlassSurface: () => null }));
vi.mock("../../components/PierreEntryIcon", () => ({ PierreEntryIcon: () => null }));
vi.mock("../../components/ProviderIcon", () => ({ ProviderIcon: () => null }));
vi.mock("../pull-requests/pullRequestStatus", () => ({ pullRequestStatus: () => null }));

import { emptyText } from "./ComposerCommandPopover";

describe("ComposerCommandPopover empty text", () => {
  it("names mentions when an @ search finds nothing, since the picker lists threads too", () => {
    expect(emptyText("path", false)).toBe("No matching mentions.");
  });
});
