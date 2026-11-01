import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { GoatBotComposer } from "./GoatBotComposer";

let root: Root | undefined;
let container: HTMLDivElement;

afterEach(async () => {
  await act(() => root?.unmount());
  container?.remove();
  root = undefined;
});

async function render(disabled = false, initialText = "") {
  const onSend = vi.fn<(text: string) => void>();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(() => {
    root?.render(
      <GoatBotComposer
        disabled={disabled}
        placeholder="Message GOAT Bot"
        initialText={initialText}
        onSend={onSend}
      />,
    );
  });
  const textarea = container.querySelector("textarea")!;
  return { onSend, textarea };
}

async function type(textarea: HTMLTextAreaElement, value: string) {
  await act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function press(
  textarea: HTMLTextAreaElement,
  init: KeyboardEventInit & { composing?: boolean },
) {
  await act(() => {
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
      ...init,
    });
    if (init.composing) Object.defineProperty(event, "isComposing", { value: true });
    textarea.dispatchEvent(event);
  });
}

it("sends on Enter, clears, and takes the next message right away", async () => {
  const { onSend, textarea } = await render();
  await type(textarea, "  fix the flaky test  ");
  await press(textarea, {});
  expect(onSend).toHaveBeenCalledWith("fix the flaky test");
  expect(textarea.value).toBe("");
  await type(textarea, "and update the docs");
  await press(textarea, {});
  expect(onSend).toHaveBeenLastCalledWith("and update the docs");
  expect(onSend).toHaveBeenCalledTimes(2);
});

it("keeps Shift+Enter and IME confirmation as editing keys", async () => {
  const { onSend, textarea } = await render();
  await type(textarea, "line one");
  await press(textarea, { shiftKey: true });
  await press(textarea, { composing: true });
  expect(onSend).not.toHaveBeenCalled();
  expect(textarea.value).toBe("line one");
});

it("sends nothing when blank or unavailable", async () => {
  const blank = await render();
  await type(blank.textarea, "   ");
  await press(blank.textarea, {});
  expect(blank.onSend).not.toHaveBeenCalled();
  await act(() => root?.unmount());
  container.remove();

  const off = await render(true);
  await press(off.textarea, {});
  expect(off.onSend).not.toHaveBeenCalled();
});

it("starts with suggested text without sending it", async () => {
  const { onSend, textarea } = await render(false, "Review the latest changes");
  expect(textarea.value).toBe("Review the latest changes");
  expect(onSend).not.toHaveBeenCalled();
});
