import { DEFAULT_UNIFIED_SETTINGS } from "@goat/contracts/settings";
import { GTProvider } from "gt-react";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import zh from "../../i18n/translations/zh.json";
import { ToolCallVisibilityRow } from "./ToolCallVisibilityRow";

const update = vi.fn();
vi.mock(import("./useScopedSettings"), async (importOriginal) => ({
  ...(await importOriginal()),
  useScopedSettings: vi
    .fn()
    .mockReturnValue({ ...DEFAULT_UNIFIED_SETTINGS, toolCallVisibility: "showAll" }),
  useUpdateScopedSettings: () => update,
}));

it("translates the selected mode and sends the stable value when another mode is chosen", async () => {
  await using screen = await render(
    <GTProvider locale="zh" translations={{ zh }}>
      <ToolCallVisibilityRow />
    </GTProvider>,
  );
  const trigger = screen.getByRole("combobox");
  await expect.element(trigger).toHaveTextContent("全部显示");
  await trigger.click();
  await screen.getByRole("option", { name: "隐藏成功的调用" }).click();
  expect(update).toHaveBeenCalledWith({ toolCallVisibility: "hideSuccessful" });
});
