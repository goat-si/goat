import * as NodeVM from "node:vm";
import { describe, expect, it } from "vite-plus/test";
import {
  htmlRenderShortcutsMessage,
  injectHtmlRenderBootstrap,
  readHtmlRenderImageRequest,
  readHtmlRenderKeyDown,
} from "./htmlRender.ts";

import { LEGACY_HTML_BOOTSTRAP_SCRIPT } from "./htmlRenderLegacyBootstrap.fixture.ts";

const shortcut = { key: "k", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false };

// Execute the published bridge, including its delayed key listener, without a browser's UI.
function pageBridge(savedScript?: string) {
  const listeners = new Map<string, Array<(event: Record<string, unknown>) => void>>();
  const messages: Array<{ method: string; params: Record<string, unknown> }> = [];
  const timers: Array<() => void> = [];
  const parent = { postMessage: (message: (typeof messages)[number]) => messages.push(message) };
  const window = {
    parent,
    addEventListener: (type: string, fn: (event: Record<string, unknown>) => void) => {
      const list = listeners.get(type) ?? [];
      list.push(fn);
      listeners.set(type, list);
    },
    removeEventListener: (type: string, fn: (event: Record<string, unknown>) => void) => {
      const list = listeners.get(type);
      if (list) list.splice(list.indexOf(fn), 1);
    },
  };
  const document = { getElementById: () => ({ textContent: "" }), addEventListener: () => {} };
  const html = injectHtmlRenderBootstrap("<p>Saved page</p>");
  const script = savedScript ?? /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
  expect(script).toBeDefined();
  NodeVM.runInNewContext(script!, {
    window,
    document,
    location: { hash: "" },
    setTimeout: (fn: () => void) => timers.push(fn),
  });
  const dispatch = (type: string, event: Record<string, unknown>) => {
    const list = listeners.get(type) ?? [];
    // Listeners added during capture run in the later bubble phase of the same dispatch.
    for (let index = 0; index < list.length; index++) list[index]!(event);
    for (const fn of timers.splice(0)) fn();
  };
  return {
    messages,
    shortcuts: (
      method: string = htmlRenderShortcutsMessage([], []).method,
      source: unknown = parent,
    ) =>
      dispatch("message", {
        source,
        data: { ...htmlRenderShortcutsMessage([shortcut], []), method },
      }),
    key: () => {
      const event = {
        ...shortcut,
        key: "k",
        code: "KeyK",
        repeat: false,
        isTrusted: true,
        isComposing: false,
        defaultPrevented: false,
        composedPath: () => [],
        getModifierState: () => false,
        preventDefault() {
          this.defaultPrevented = true;
        },
      };
      dispatch("keydown", event);
      return event.defaultPrevented;
    },
    image: () =>
      dispatch("click", {
        isTrusted: true,
        defaultPrevented: false,
        button: 0,
        composedPath: () => [
          {
            tagName: "IMG",
            src: "https://example.com/chart.png",
            alt: "Chart",
            closest: () => null,
          },
        ],
      }),
  };
}

describe("HTML bridge version compatibility", () => {
  it("a new client still configures an old saved page with a legacy-only listener", () => {
    const page = pageBridge(LEGACY_HTML_BOOTSTRAP_SCRIPT);
    expect(page.key()).toBe(false);
    page.shortcuts();
    expect(page.key()).toBe(true);
    page.image();
    expect(page.messages.map((message) => message.method)).toEqual([
      "t3/notifications/keydown",
      "t3/notifications/open-image",
    ]);
    expect(readHtmlRenderKeyDown(page.messages[0])?.code).toBe("KeyK");
    expect(readHtmlRenderImageRequest(page.messages[1])?.src).toBe("https://example.com/chart.png");
  });

  it.each(["t3", "goat"])(
    "a new page accepts %s shortcuts and writes once to an old-client parser",
    (prefix) => {
      const page = pageBridge();
      page.shortcuts(`${prefix}/notifications/shortcuts`);
      expect(page.key()).toBe(true);
      page.image();
      // An old client recognizes only these two legacy methods.
      const oldClient = page.messages.filter((message) =>
        ["t3/notifications/keydown", "t3/notifications/open-image"].includes(message.method),
      );
      expect(oldClient).toHaveLength(2);
      expect(page.messages).toEqual(oldClient);
      expect(readHtmlRenderKeyDown(oldClient[0])?.code).toBe("KeyK");
      expect(readHtmlRenderImageRequest(oldClient[1])?.name).toBe("Chart");
    },
  );

  it("does not configure shortcuts from an unrelated frame or unknown method", () => {
    const page = pageBridge();
    page.shortcuts("goat/notifications/shortcuts", {});
    page.shortcuts("other/notifications/shortcuts");
    expect(page.key()).toBe(false);
    expect(page.messages).toEqual([]);
  });

  it.each(["t3", "goat"])("new clients validate %s event payloads", (prefix) => {
    expect(
      readHtmlRenderKeyDown({
        jsonrpc: "2.0",
        method: `${prefix}/notifications/keydown`,
        params: { ...shortcut, code: "KeyK" },
      })?.key,
    ).toBe("k");
    expect(
      readHtmlRenderImageRequest({
        jsonrpc: "2.0",
        method: `${prefix}/notifications/open-image`,
        params: { src: "https://example.com/image.png" },
      })?.name,
    ).toBe("Image");
    expect(
      readHtmlRenderKeyDown({
        jsonrpc: "1.0",
        method: `${prefix}/notifications/keydown`,
        params: { ...shortcut, code: "KeyK" },
      }),
    ).toBeUndefined();
    expect(
      readHtmlRenderKeyDown({
        jsonrpc: "2.0",
        method: `${prefix}/notifications/keydown`,
        params: { key: 1 },
      }),
    ).toBeUndefined();
    expect(
      readHtmlRenderImageRequest({
        jsonrpc: "2.0",
        method: `${prefix}/notifications/open-image`,
        params: { src: "javascript:alert(1)" },
      }),
    ).toBeUndefined();
  });
});
