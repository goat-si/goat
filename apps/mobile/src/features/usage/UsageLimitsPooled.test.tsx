import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Pressable: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Linking: {},
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => new Map() }));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({}) }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("@goat/shared/usageLimitsBoard", () => ({
  limitBoard: () => ({
    sections: [
      {
        groups: [
          {
            windows: [],
            rows: [
              {
                account: {
                  key: "a",
                  driver: "claudeAgent",
                  environments: [],
                  sourceLabel: "Hub",
                  limits: { checkedAt: "2026-01-01T00:00:00Z", windows: [], zeroSpendCap: true },
                },
              },
            ],
          },
        ],
      },
    ],
  }),
}));
vi.mock("../../state/presentation", () => ({
  environmentPresentations: { presentationsWithProvidersAtom: {} },
}));
vi.mock("../../components/ui/ScreenScrollView", () => ({
  ScreenScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ProviderIcon", () => ({ ProviderIcon: () => null }));
vi.mock("../settings/components/SettingsScreen", () => ({
  SettingsScreen: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("./UsageLimitsSection", () => ({ ResetCredits: () => null }));
vi.mock("./usageProviders", () => ({
  usageProviderKind: () => "claudeAgent",
  useProviderColors: () => ({}),
}));
import { UsageLimitAccountScreen } from "./UsageLimitsPooled";

it("shows the zero spend cap on the pooled account detail with no windows", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(() =>
      root.render(
        <UsageLimitAccountScreen
          route={{
            params: { accountKey: "a", environmentIds: null, now: 0 },
          }}
        />,
      ),
    );
    expect(container.textContent).toContain("Monthly spend: $0 cap");
  } finally {
    await act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
