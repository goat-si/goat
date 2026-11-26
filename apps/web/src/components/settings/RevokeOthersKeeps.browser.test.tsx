import { GTProvider } from "gt-react";
import { expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import zh from "../../i18n/translations/zh.json";
import { RevokeOthersButton } from "./RevokeOthersKeeps";

it("explains which sessions are kept in the selected language", async () => {
  await using screen = await render(
    <GTProvider locale="zh" translations={{ zh }}>
      <RevokeOthersButton disabled revoking={false} onClick={() => {}} />
    </GTProvider>,
  );
  await expect
    .element(screen.getByRole("button", { name: "撤销其他会话", exact: true }))
    .toBeDisabled();
  const explain = screen.getByRole("button", { name: "撤销其他会话时会保留哪些会话" });
  explain.element().focus();
  await userEvent.keyboard("{Enter}");
  await expect
    .element(page.getByText("你可以在下方逐个撤销这些会话。", { exact: false }))
    .toBeVisible();
});
