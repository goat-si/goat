import { RegistryProvider } from "@effect/atom-react";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import { materialBridge } from "../../../test/windowMaterial";
import { getClientSettings } from "../../hooks/useSettings";
import { AppearanceSettingsPanel } from "./AppearanceSettingsPanel";
import "../../index.css";

vi.mock("./SettingsScopeContext", () => ({
  useOptionalSettingsScope: () => null,
  useSettingsScope: () => ({
    target: null,
    targets: [],
    environments: [],
    scope: { kind: "all", label: "All environments", members: [], environmentIds: [] },
  }),
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => vi.fn(),
}));

vi.mock("../../hooks/useTheme", () => ({
  useTheme: () => ({
    appearanceMode: "system",
    refreshTheme: vi.fn(),
    resolvedTheme: "light",
    setAppearanceMode: vi.fn(),
    setTheme: vi.fn(),
    setThemeHalf: vi.fn(),
    theme: "system",
    themeHalves: null,
  }),
}));

vi.mock("../../hooks/useCustomThemes", () => ({ useCustomThemes: () => [] }));
vi.mock("../sidebar/brandChannel", () => ({
  resolveEnvironmentIdentificationPillLabel: () => null,
  useEnvironmentStageLabel: () => null,
}));
vi.mock("./ThemeSettings", () => ({ ThemeLibrary: () => null }));
vi.mock("./TypographySettings", () => ({ TypographySection: () => null }));
vi.mock("./DesktopWindowMaterialSetting", () => ({ DesktopWindowMaterialSetting: () => null }));
vi.mock("./settingsLayout", () => ({
  SettingsPageContainer: ({ children }: { children: import("react").ReactNode }) => <>{children}</>,
  SettingsSection: ({ children }: { children: import("react").ReactNode }) => <>{children}</>,
  SettingsRow: ({
    title,
    description,
    control,
    resetAction,
  }: {
    title: string;
    description?: string;
    control: import("react").ReactNode;
    resetAction?: import("react").ReactNode;
  }) => (
    <div>
      <h3>{title}</h3>
      <p>{description}</p>
      {control}
      {resetAction}
    </div>
  ),
  SettingResetButton: ({ label, onClick }: { label: string; onClick: () => void }) => (
    <button type="button" aria-label={`Reset ${label}`} onClick={onClick} />
  ),
}));

it("selects and restores the Liquid Glass style through client settings", async () => {
  using fixture = materialBridge();
  await using screen = await render(
    <RegistryProvider>
      <AppearanceSettingsPanel />
    </RegistryProvider>,
  );

  await screen.getByRole("combobox", { name: "Style" }).click();
  await screen.getByRole("option", { name: "Liquid Glass" }).click();
  await vi.waitFor(() => expect(getClientSettings().appearancePreset).toBe("liquid-glass"));
  await expect
    .element(
      screen.getByText("Higher values make panels, menus, dialogs, and the composer more solid."),
    )
    .toBeVisible();

  await screen.getByRole("combobox", { name: "Style" }).click();
  await screen.getByRole("option", { name: "Default" }).click();
  await vi.waitFor(() => expect(getClientSettings().appearancePreset).toBe("default"));
  await expect
    .element(screen.getByText("Higher values make menus, dialogs, and the composer more solid."))
    .toBeVisible();
  expect(fixture.saved().appearancePreset).toBe("default");
});
