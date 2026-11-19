import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Pressable: ({ children }: { children?: ReactNode }) => <button>{children}</button>,
  StyleSheet: { hairlineWidth: 1 },
}));
vi.mock("expo-image", () => ({ Image: () => null }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/GlassSurface", () => ({
  GlassSurface: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/PierreEntryIcon", () => ({ PierreEntryIcon: () => null }));
vi.mock("../../components/ProviderIcon", () => ({ ProviderIcon: () => null }));
vi.mock("../pull-requests/pullRequestStatus", () => ({ pullRequestStatus: () => null }));
import { ComposerCommandPopover } from "./ComposerCommandPopover";

it("shows retained mentions and a thread search error together", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    act(() =>
      root.render(
        <ComposerCommandPopover
          triggerKind="path"
          isLoading={false}
          error="Couldn't search threads."
          onSelect={() => {}}
          items={[
            {
              id: "file",
              type: "path",
              path: "report.ts",
              kind: "file",
              label: "report.ts",
              description: "",
            },
          ]}
        />,
      ),
    );
    expect(container.textContent).toContain("report.ts");
    expect(container.textContent).toContain("Couldn't search threads.");
  } finally {
    act(() => root.unmount());
  }
});
