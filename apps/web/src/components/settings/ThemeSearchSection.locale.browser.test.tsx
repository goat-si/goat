import { GTProvider } from "gt-react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import zh from "../../i18n/translations/zh.json";
import { ThemeImportDialog } from "./ThemeImportDialog";

vi.mock("../../openVsxThemes", () => ({
  importOpenVsxThemeExtension: vi.fn(),
  searchOpenVsxThemes: async () => [
    { id: "acme.nightfall", name: "Nightfall", publisher: "acme", downloadCount: 10 },
  ],
}));
it("localizes the community theme search and install action", async () => {
  await using _screen = await render(
    <GTProvider locale="zh" translations={{ zh }}>
      <ThemeImportDialog
        open
        onOpenChange={() => {}}
        onImported={() => true}
        onImportedMany={() => {}}
      />
    </GTProvider>,
  );
  await userEvent.fill(page.getByLabelText("搜索 Open VSX 主题"), "night");
  await expect.element(page.getByRole("button", { name: "安装 Nightfall" })).toBeVisible();
  await expect.element(page.getByText("acme · 10 次下载")).toBeVisible();
});
