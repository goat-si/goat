import { RegistryProvider } from "@effect/atom-react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { materialBridge } from "../../../test/windowMaterial";
import { getClientSettings } from "../../hooks/useSettings";
import { AppearanceSettingsPanel } from "./AppearanceSettingsPanel";
import "../../index.css";

const backdrop = vi.hoisted(() => ({
  presence: "missing" as "loading" | "present" | "missing",
  save: vi.fn<
    (
      _file: Blob,
    ) => Promise<{ ok: true } | { ok: false; error: "not-image" | "too-large" | "unreadable" }>
  >(async () => ({ ok: true })),
  clear: vi.fn(async () => {}),
}));

vi.mock("../../appearance/glassBackdropStore", () => ({
  saveCustomBackdrop: backdrop.save,
  clearCustomBackdrop: backdrop.clear,
  useCustomBackdropPresence: () => backdrop.presence,
}));

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
  backdrop.presence = "missing";
  using fixture = materialBridge();
  await using screen = await render(
    <RegistryProvider>
      <AppearanceSettingsPanel />
    </RegistryProvider>,
  );

  await expect
    .element(screen.getByRole("combobox", { name: "Background" }))
    .not.toBeInTheDocument();

  await screen.getByRole("combobox", { name: "Style" }).click();
  await screen.getByRole("option", { name: "Liquid Glass" }).click();
  await vi.waitFor(() => expect(getClientSettings().appearancePreset).toBe("liquid-glass"));
  await expect.element(screen.getByRole("combobox", { name: "Background" })).toBeVisible();
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

it("saves a chosen image and selects the custom background", async () => {
  backdrop.presence = "missing";
  backdrop.save.mockReset().mockResolvedValue({ ok: true });
  using _fixture = materialBridge();
  await using screen = await render(
    <RegistryProvider>
      <AppearanceSettingsPanel />
    </RegistryProvider>,
  );

  await screen.getByRole("combobox", { name: "Style" }).click();
  await screen.getByRole("option", { name: "Liquid Glass" }).click();
  const image = new File(["image"], "background.png", { type: "image/png" });
  await userEvent.upload(screen.getByLabelText("Background image"), image);
  await vi.waitFor(() => expect(backdrop.save).toHaveBeenCalledWith(image));
  await vi.waitFor(() => expect(getClientSettings().glassBackdrop).toBe("custom"));
  await expect
    .element(screen.getByRole("combobox", { name: "Background" }))
    .toHaveTextContent("Custom image");
});

it("shows the image validation error in the Background row", async () => {
  backdrop.presence = "missing";
  backdrop.save.mockReset().mockResolvedValue({ ok: false, error: "not-image" });
  using _fixture = materialBridge();
  await using screen = await render(
    <RegistryProvider>
      <AppearanceSettingsPanel />
    </RegistryProvider>,
  );

  await screen.getByRole("combobox", { name: "Style" }).click();
  await screen.getByRole("option", { name: "Liquid Glass" }).click();
  await userEvent.upload(
    screen.getByLabelText("Background image"),
    new File(["text"], "not-image.png", { type: "image/png" }),
  );
  await expect.element(screen.getByText("Choose an image file.")).toBeVisible();
  expect(getClientSettings().glassBackdrop).toBe("built-in");
});

it("removes a stored background and returns to the built-in background", async () => {
  backdrop.presence = "present";
  backdrop.clear.mockClear();
  using _fixture = materialBridge();
  await using screen = await render(
    <RegistryProvider>
      <AppearanceSettingsPanel />
    </RegistryProvider>,
  );

  await screen.getByRole("combobox", { name: "Style" }).click();
  await screen.getByRole("option", { name: "Liquid Glass" }).click();
  await screen.getByRole("combobox", { name: "Background" }).click();
  await screen.getByRole("option", { name: "Custom image" }).click();
  await vi.waitFor(() => expect(getClientSettings().glassBackdrop).toBe("custom"));
  await screen.getByRole("button", { name: "Remove" }).click();
  await vi.waitFor(() => expect(backdrop.clear).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(getClientSettings().glassBackdrop).toBe("built-in"));
});
