import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  show: vi.fn(),
  markRead: vi.fn(async () => {}),
  supported: true,
}));

vi.mock("~/localApi", () => ({ readLocalApi: () => ({ contextMenu: { show: state.show } }) }));
vi.mock("./useGoatBotWaitingCount", () => ({
  useMarkGoatBotRead: () => (state.supported ? state.markRead : null),
}));

import { useGoatBotReadMenu } from "./useGoatBotReadMenu";

function BotEntry({ count }: { count: number | undefined }) {
  return (
    <button type="button" {...useGoatBotReadMenu(count)}>
      GOAT Bot
    </button>
  );
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.show.mockReset();
  state.markRead.mockClear();
  state.supported = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function renderEntry(count: number | undefined) {
  await act(() => root.render(<BotEntry count={count} />));
  return container.querySelector("button")!;
}

function rightClick(element: Element) {
  const event = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: 20,
    clientY: 30,
  });
  element.dispatchEvent(event);
  return event;
}

describe("useGoatBotReadMenu", () => {
  it("marks all read when the enabled item is chosen", async () => {
    state.show.mockResolvedValue("mark-read");
    const button = await renderEntry(2);
    let event!: MouseEvent;
    await act(async () => {
      event = rightClick(button);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(state.show).toHaveBeenCalledWith(
      [{ id: "mark-read", label: "Mark all as read", disabled: false }],
      { x: 20, y: 30 },
    );
    expect(state.markRead).toHaveBeenCalledTimes(1);
  });

  it("disables the item when nothing is unread", async () => {
    state.show.mockResolvedValue(null);
    const button = await renderEntry(0);
    await act(async () => {
      rightClick(button);
    });
    expect(state.show.mock.calls[0]?.[0]).toEqual([
      { id: "mark-read", label: "Mark all as read", disabled: true },
    ]);
    expect(state.markRead).not.toHaveBeenCalled();
  });

  it("opens from the keyboard at the entry", async () => {
    state.show.mockResolvedValue(null);
    const button = await renderEntry(1);
    button.getBoundingClientRect = () => ({ left: 4, bottom: 44 }) as DOMRect;
    for (const init of [{ key: "F10", shiftKey: true }, { key: "ContextMenu" }]) {
      await act(async () => {
        button.dispatchEvent(new KeyboardEvent("keydown", { ...init, bubbles: true }));
      });
    }
    expect(state.show).toHaveBeenCalledTimes(2);
    expect(state.show.mock.calls.map((call) => call[1])).toEqual([
      { x: 4, y: 44 },
      { x: 4, y: 44 },
    ]);
  });

  it("leaves the platform menu alone when the server cannot count read tasks", async () => {
    state.supported = false;
    const button = await renderEntry(3);
    const event = rightClick(button);
    expect(event.defaultPrevented).toBe(false);
    expect(state.show).not.toHaveBeenCalled();
  });
});
