import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { Sidebar, SidebarProvider } from "../ui/sidebar";
import { SETTINGS_SEARCH_ITEMS } from "./settingsSearch";
import { SettingsSearchShortcut } from "./SettingsSearchShortcut";
import { SettingsSidebarNav } from "./SettingsSidebarNav";

vi.mock("./useAvailableSettingsSearchItems", () => ({
  useAvailableSettingsSearchItems: () => SETTINGS_SEARCH_ITEMS,
}));
vi.mock("../sidebar/SidebarChrome", () => ({ SidebarUtilityMenu: () => null }));

// Mirrors the Settings composition in AppSidebarLayout.
function SettingsSidebar({ defaultOpen = true }: { defaultOpen?: boolean }) {
  return (
    <SidebarProvider defaultOpen={defaultOpen}>
      <Sidebar side="left" collapsible="offcanvas">
        <SettingsSidebarNav pathname="/settings/hub" />
      </Sidebar>
      <SettingsSearchShortcut />
      <main>Hub settings</main>
    </SidebarProvider>
  );
}

const searchInput = () => page.getByRole("combobox", { name: "Search settings" });

describe("Settings search shortcut", () => {
  it("opens the closed phone-width sidebar with search focused (#1198)", async () => {
    await page.viewport(390, 844);
    await using screen = await render(<SettingsSidebar />, { router: "/settings/hub" });
    await expect.element(screen.getByText("Hub settings")).toBeVisible();
    await expect.element(searchInput()).not.toBeInTheDocument();

    await userEvent.keyboard("/");

    await expect.element(searchInput()).toHaveFocus();
  });

  it("focuses search from inside the open phone-width sidebar", async () => {
    await page.viewport(390, 844);
    await using _screen = await render(<SettingsSidebar />, { router: "/settings/hub" });
    await userEvent.keyboard("/");
    await expect.element(searchInput()).toHaveFocus();
    const section = page.getByRole("button", { name: "Appearance" });
    (await section.element()).focus();
    await expect.element(section).toHaveFocus();

    await userEvent.keyboard("/");

    await expect.element(searchInput()).toHaveFocus();
  });

  it("expands a collapsed desktop sidebar on Mod+F with search focused", async () => {
    await page.viewport(1280, 900);
    await using _screen = await render(<SettingsSidebar defaultOpen={false} />, {
      router: "/settings/hub",
    });

    await userEvent.keyboard("{Control>}f{/Control}");

    await expect.element(searchInput()).toHaveFocus();
  });
});
