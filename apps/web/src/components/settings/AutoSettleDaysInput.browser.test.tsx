import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { AutoSettleDaysInput } from "./AutoSettleDaysInput";

it("keeps edits local until the number is committed", async () => {
  const save = vi.fn();
  await using screen = await render(<AutoSettleDaysInput value={14} onCommit={save} />);
  const input = screen.getByRole("spinbutton", { name: "Days of inactivity before auto-settle" });
  await userEvent.fill(input, "30");
  expect(save).not.toHaveBeenCalled();
  await userEvent.keyboard("{Enter}");
  expect(save).toHaveBeenCalledOnce();
  expect(save.mock.calls[0]?.[0]).toBe(30);
});
