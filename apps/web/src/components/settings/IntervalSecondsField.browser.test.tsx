import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";
import { IntervalSecondsField } from "./IntervalSecondsField";

describe("IntervalSecondsField", () => {
  it("commits on Enter without losing focus and ignores IME Enter", async () => {
    const onCommit = vi.fn();
    await using _screen = await render(
      <IntervalSecondsField
        label="Provider health check interval"
        value={300}
        min={30}
        step={30}
        onCommit={onCommit}
      />,
    );
    const input = page.getByRole("textbox", { name: "Provider health check interval in seconds" });

    await userEvent.type(input, "{Backspace}{Backspace}{Backspace}120");
    // An Enter that confirms an IME candidate must not commit.
    for (const composition of [
      { isComposing: true, keyCode: 13 },
      { isComposing: false, keyCode: 229 },
    ]) {
      await act(() =>
        input.element().dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            ...composition,
            bubbles: true,
            cancelable: true,
          }),
        ),
      );
    }
    expect(onCommit).not.toHaveBeenCalled();

    await userEvent.keyboard("{Enter}");
    await expect.element(input).toHaveFocus();
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(
      120,
      expect.objectContaining({ onFailed: expect.any(Function) }),
    );
  });
});
