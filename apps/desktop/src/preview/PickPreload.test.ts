import { expect, it, vi } from "vite-plus/test";

import {
  ELEMENT_PICKED_CHANNEL,
  HUMAN_INPUT_CHANNEL,
  POINTER_DOWN_HOST_CHANNEL,
  START_PICK_CHANNEL,
  THUMB_PRESS_CHANNEL,
} from "./GuestProtocol.ts";
import "./PickPreload.ts";

const ipcListeners = vi.hoisted(() => new Map<string, Array<(...args: unknown[]) => void>>());
const ipcSends = vi.hoisted(() => ({ send: vi.fn(), sendToHost: vi.fn() }));

vi.mock("electron", () => ({
  ipcRenderer: {
    on: (channel: string, listener: (...args: unknown[]) => void) => {
      ipcListeners.set(channel, [...(ipcListeners.get(channel) ?? []), listener]);
    },
    off: () => {},
    send: ipcSends.send,
    sendToHost: ipcSends.sendToHost,
    invoke: async () => undefined,
  },
}));

vi.mock("react-grab/primitives", () => ({ getElementContext: async () => null }));

const startAnnotation = (): ShadowRoot => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  using attachShadow = vi.spyOn(Element.prototype, "attachShadow");
  for (const listener of ipcListeners.get(START_PICK_CHANNEL) ?? []) listener({}, undefined, false);
  const shadowRoot = attachShadow.mock.results[0]?.value;
  if (!(shadowRoot instanceof ShadowRoot)) throw new Error("annotation overlay did not start");
  return shadowRoot;
};

it("switches tools from the keyboard after a toolbar button is clicked", () => {
  const shadowRoot = startAnnotation();
  const region = Array.from(shadowRoot.querySelectorAll("button")).find(
    (button) => button.textContent === "Region",
  );
  if (!region) throw new Error("Region toolbar button not found");

  region.focus();
  region.click();
  expect(document.documentElement.getAttribute("data-goat-annotation-tool")).toBe("marquee");

  region.dispatchEvent(new KeyboardEvent("keydown", { key: "v", bubbles: true, composed: true }));

  expect(
    document.documentElement.getAttribute("data-goat-annotation-tool"),
    "V should switch to Select while focus is on a toolbar button",
  ).toBe("select");
});

it("keeps the tool while typing a tool key in the comment", () => {
  const shadowRoot = startAnnotation();
  const comment = shadowRoot.querySelector("textarea");
  if (!comment) throw new Error("comment textarea not found");

  comment.focus();
  comment.dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true, composed: true }));

  expect(document.documentElement.getAttribute("data-goat-annotation-tool")).toBe("select");
});

it("keeps the annotation when Escape dismisses an IME candidate in the comment", () => {
  const shadowRoot = startAnnotation();
  const comment = shadowRoot.querySelector("textarea");
  if (!comment) throw new Error("comment textarea not found");

  comment.value = "draft";
  comment.focus();
  comment.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Escape",
      isComposing: true,
      bubbles: true,
      cancelable: true,
      composed: true,
    }),
  );

  expect(shadowRoot.host.isConnected).toBe(true);
  expect(comment.value).toBe("draft");
});

it("keeps comment keystrokes away from the page's capture-phase shortcuts", () => {
  const pageShortcut = vi.fn((event: KeyboardEvent) => event.preventDefault());
  window.addEventListener("keydown", pageShortcut, { capture: true });
  const shadowRoot = startAnnotation();
  const comment = shadowRoot.querySelector("textarea");
  if (!comment) throw new Error("comment textarea not found");

  comment.focus();
  const space = new KeyboardEvent("keydown", {
    key: " ",
    code: "Space",
    bubbles: true,
    cancelable: true,
    composed: true,
  });
  comment.dispatchEvent(space);
  window.removeEventListener("keydown", pageShortcut, { capture: true });

  expect(pageShortcut).not.toHaveBeenCalled();
  expect(space.defaultPrevented).toBe(false);
});

it("a replayed thumb press tells the host page and the main process, like a click", () => {
  for (const listener of ipcListeners.get(THUMB_PRESS_CHANNEL) ?? []) {
    listener({}, "down", 5, 6, 3);
  }
  expect(ipcSends.sendToHost).toHaveBeenCalledWith(POINTER_DOWN_HOST_CHANNEL);
  expect(ipcSends.send).toHaveBeenCalledWith(HUMAN_INPUT_CHANNEL, {
    kind: "pointer",
    x: 5,
    y: 6,
    button: 3,
  });
});

it.each([
  { scrolled: false, rect: { x: 40, y: 60, width: 200, height: 120 } },
  // The last rect would point at whatever now sits there, so no crop beats a wrong one.
  { scrolled: true, rect: { x: 0, y: 0, width: 0, height: 0 } },
])(
  "submits a replaced element's last rect unless the page scrolled ($scrolled)",
  async ({ scrolled, rect }) => {
    const picked = Promise.withResolvers<{ elements: Array<{ rect: unknown }> }>();
    ipcSends.send.mockImplementation((channel, annotation) => {
      if (channel === ELEMENT_PICKED_CHANNEL) picked.resolve(annotation);
    });
    const card = document.body.appendChild(document.createElement("div"));
    const pickedRect = new DOMRect(40, 60, 200, 120);
    // Browsers report a detached element at 0x0 in the corner.
    using _rect = vi
      .spyOn(card, "getBoundingClientRect")
      .mockImplementation(() => (card.isConnected ? pickedRect : new DOMRect()));
    const properties = new DisposableStack();
    using _restore = properties;
    const previous = Object.getOwnPropertyDescriptor(document, "elementsFromPoint");
    Object.defineProperty(document, "elementsFromPoint", {
      configurable: true,
      value: () => [card],
    });
    properties.defer(() => {
      if (previous) Object.defineProperty(document, "elementsFromPoint", previous);
      else Reflect.deleteProperty(document, "elementsFromPoint");
    });
    using listeners = vi.spyOn(HTMLButtonElement.prototype, "addEventListener");

    const shadowRoot = startAnnotation();

    card.dispatchEvent(
      new PointerEvent("pointerdown", { button: 0, clientX: 100, clientY: 100, bubbles: true }),
    );
    // A polling page re-renders while the comment is written and replaces the picked node.
    card.remove();
    if (scrolled) window.dispatchEvent(new Event("scroll"));
    const attach = Array.from(shadowRoot.querySelectorAll("button")).find(
      (button) => button.textContent === "Attach",
    );
    if (!attach) throw new Error("Attach button not found");
    attach.click();
    expect(attach.disabled).toBe(false);
    expect(ipcSends.send).not.toHaveBeenCalledWith(ELEMENT_PICKED_CHANNEL, expect.anything());
    const listenerIndex = listeners.mock.contexts.findIndex(
      (target, index) => target === attach && listeners.mock.calls[index]?.[0] === "click",
    );
    const listener = listeners.mock.calls[listenerIndex]?.[1];
    if (typeof listener !== "function") throw new Error("Attach click listener not found");
    // The DOM test environment has no native input source.
    listener.call(attach, { isTrusted: true } as MouseEvent);

    expect((await picked.promise).elements[0]?.rect).toEqual(rect);
  },
);

it("shows the annotation comment limit while retaining a comment at the boundary", () => {
  const shadowRoot = startAnnotation();
  const comment = shadowRoot.querySelector("textarea");
  if (!comment) throw new Error("comment textarea not found");
  expect(comment.maxLength).toBe(8000);
  comment.value = "x".repeat(8000);
  comment.dispatchEvent(new Event("input", { bubbles: true }));
  expect(comment.value).toHaveLength(8000);
  expect(shadowRoot.textContent).toContain("8000 / 8000");
});

it("keeps an oversized inserted annotation and shows its count", () => {
  const shadowRoot = startAnnotation();
  const comment = shadowRoot.querySelector("textarea");
  const attach = Array.from(shadowRoot.querySelectorAll("button")).find(
    (button) => button.textContent === "Attach",
  );
  if (!comment || !attach) throw new Error("annotation editor not found");
  comment.value = "x".repeat(8001);
  comment.dispatchEvent(new Event("input", { bubbles: true }));
  attach.click();
  expect(comment.value).toHaveLength(8001);
  expect(shadowRoot.textContent).toContain("8001 / 8000");
  expect(shadowRoot.host.isConnected).toBe(true);
});
