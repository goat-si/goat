import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

const { mocks, Children } = vi.hoisted(() => ({
  mocks: {
    platform: "ios",
    available: true,
    pending: false,
    openURL: vi.fn(),
    alert: vi.fn(),
    check: vi.fn(),
  },
  Children: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("react-native", () => ({
  View: Children,
  Platform: { select: (values: Record<string, unknown>) => values[mocks.platform] },
  Linking: { openURL: mocks.openURL },
}));
vi.mock("expo-application", () => ({ applicationId: "si.goat.mobile", nativeBuildVersion: "1" }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "1.0" } } }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("../../components/ui/Dialog", () => ({ alert: mocks.alert }));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: Children }));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../i18n/I18nProvider", () => ({
  I18nProvider: Children,
  useGT: () => (s: string) => s,
}));
vi.mock("../../lib/clock", () => ({ useDeadlinePassed: () => false }));
vi.mock("./components/SettingsScreen", () => ({ SettingsScreen: Children }));
vi.mock("./components/SettingsSection", () => ({ SettingsSection: Children }));
vi.mock("./components/SettingsRow", () => ({
  SettingsRow: ({
    label,
    value,
    onPress,
    disabled,
  }: {
    label: string;
    value?: string;
    onPress?: () => void;
    disabled?: boolean;
  }) => (
    <button disabled={disabled} onClick={onPress}>
      {label}
      {value}
    </button>
  ),
}));
vi.mock("../updates/app-updates", () => ({
  isAppUpdateCheckAvailable: () => mocks.available,
  isAppUpdatePending: () => mocks.pending,
  runAppUpdateCheck: mocks.check,
}));

describe("About update actions (#3810)", () => {
  it.each([
    ["ios", "https://testflight.apple.com/join/4PXeSgXv"],
    ["android", "https://appdistribution.firebase.dev/i/b6f930a2e01c9f53"],
  ])(
    "checks updates and opens the %s beta destination, reporting link failures",
    async (platform, url) => {
      mocks.platform = platform;
      vi.resetModules();
      const { SettingsAboutRouteScreen } = await import("./SettingsAboutRouteScreen");
      mocks.available = true;
      mocks.check
        .mockReset()
        .mockImplementation(async ({ onStateChange }: { onStateChange: (s: string) => void }) =>
          onStateChange("ready"),
        );
      mocks.openURL.mockReset().mockRejectedValue(new Error("cannot open"));
      mocks.alert.mockReset();
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      const container = document.createElement("div");
      const root = createRoot(container);
      await act(async () => root.render(<SettingsAboutRouteScreen />));
      const button = (name: string) =>
        [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(name));
      await act(async () => button("Check for app updates")?.click());
      expect(mocks.check.mock.calls[0]?.[0].applyMode).toBe("manual");
      expect(button("Install app update")).toBeDefined();
      await act(async () => button("Install app update")?.click());
      expect(mocks.check.mock.calls[1]?.[0].applyMode).toBe("immediate");
      await act(async () => button("Check beta builds")?.click());
      expect(mocks.openURL).toHaveBeenCalledWith(url);
      expect(mocks.alert).toHaveBeenCalledWith("Could not open beta builds", url);
      await act(async () => root.unmount());
    },
  );
  it("keeps the install action after leaving and returning (#3830)", async () => {
    const { SettingsAboutRouteScreen } = await import("./SettingsAboutRouteScreen");
    mocks.available = true;
    mocks.pending = false;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.check.mockImplementation(
      async ({ onStateChange }: { onStateChange: (s: string) => void }) => {
        mocks.pending = true;
        onStateChange("ready");
      },
    );
    const container = document.createElement("div");
    const first = createRoot(container);
    await act(async () => first.render(<SettingsAboutRouteScreen />));
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((b) => b.textContent?.includes("Check for app updates"))
        ?.click(),
    );
    await act(async () => first.unmount());
    const second = createRoot(container);
    await act(async () => second.render(<SettingsAboutRouteScreen />));
    expect(container.textContent).toContain("Install app update");
    await act(async () => second.unmount());
    mocks.pending = false;
  });
  it("hides the manual check when updates are unavailable", async () => {
    const { SettingsAboutRouteScreen } = await import("./SettingsAboutRouteScreen");
    mocks.available = false;
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => root.render(<SettingsAboutRouteScreen />));
    expect(container.textContent).not.toContain("Check for app updates");
    await act(async () => root.unmount());
  });
});
