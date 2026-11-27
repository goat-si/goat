import "../index.css";
import { DEFAULT_CLIENT_SETTINGS } from "@goat/contracts";
import { useGT } from "gt-react";
import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../test/render";
import { requestConfirmDialog } from "../confirmDialog";
import { __setClientSettingsForTests, persistClientSettingsPatch } from "../hooks/useSettings";
import { I18nProvider } from "../i18n/I18nProvider";
import { startI18n, whenLocaleReady } from "../i18n/runtime";
import { ConfirmDialogHost } from "./ConfirmDialogHost";
import { threadDeleteConfirmation } from "./threadDeleteConfirmation";

function SyntheticThread() {
  const gt = useGT();
  return (
    <button
      onClick={() =>
        void requestConfirmDialog(threadDeleteConfirmation(gt, "QA? 示例"), {
          variant: "destructive",
        })
      }
    >
      Open
    </button>
  );
}

it("keeps a translated deletion question and its warning separate", async () => {
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
  startI18n();
  await persistClientSettingsPatch({ language: "zh" }, async () => {});
  await whenLocaleReady();
  await using screen = await render(
    <I18nProvider>
      <SyntheticThread />
      <ConfirmDialogHost />
    </I18nProvider>,
  );
  await screen.getByRole("button", { name: "Open" }).click();
  const dialog = page.getByRole("alertdialog", { name: "删除线程“QA? 示例”？" });
  await expect.element(dialog.getByText("此操作将永久清除该线程的对话记录。")).toBeVisible();
  await expect.element(dialog.getByRole("button", { name: "确认" })).toBeVisible();
  await dialog.getByRole("button", { name: "取消" }).click();
  await expect.element(dialog).not.toBeInTheDocument();
});
