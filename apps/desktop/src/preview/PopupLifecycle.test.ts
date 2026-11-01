import * as NodeEvents from "node:events";
import { describe, expect, it, vi } from "vite-plus/test";

import { createPreviewPopupLifecycle } from "./PopupLifecycle.ts";

const request = (url = "about:blank"): Electron.HandlerDetails => ({
  url,
  frameName: "",
  features: "",
  disposition: "new-window",
  referrer: { url: "", policy: "default" },
});

const guest = (initialUrl = "https://app.example") => {
  const events = new NodeEvents.EventEmitter();
  let url = initialUrl;
  let destroyed = false;
  let handler = (_details: Electron.HandlerDetails): Electron.WindowOpenHandlerResponse => ({
    action: "deny",
  });
  const loadURL = vi.fn();
  const contents = Object.assign(events, {
    session: { profile: Symbol("preview session") } as unknown as Electron.Session,
    getURL: () => url,
    isDestroyed: () => destroyed,
    setIgnoreMenuShortcuts: vi.fn(),
    setWindowOpenHandler: (next: typeof handler) => {
      handler = next;
    },
    loadURL,
  });
  return {
    contents: contents as unknown as Electron.WebContents,
    events,
    loadURL,
    open: (details = request()) => handler(details),
    navigate: (next: string) => {
      const event = { preventDefault: vi.fn() };
      events.emit("will-navigate", event, next);
      if (!event.preventDefault.mock.calls.length) {
        url = next;
        events.emit("did-navigate", {}, next);
      }
      return event;
    },
    destroy: () => {
      destroyed = true;
      events.emit("destroyed");
    },
  };
};

const child = (opener: ReturnType<typeof guest>, url = "about:blank") => {
  const page = guest(url);
  const events = new NodeEvents.EventEmitter();
  let destroyed = false;
  const destroy = vi.fn(() => {
    destroyed = true;
    page.destroy();
    events.emit("closed");
  });
  const window = Object.assign(events, {
    webContents: page.contents,
    isDestroyed: () => destroyed,
    destroy,
  });
  opener.events.emit("did-create-window", window);
  return { ...page, window, destroy };
};

const family = (url?: string) => {
  const owner = guest(url);
  const lifecycle = createPreviewPopupLifecycle(owner.contents, () => {});
  owner.contents.setWindowOpenHandler(lifecycle.open);
  return { owner, lifecycle };
};

describe("native preview popup lifecycle", () => {
  it("pins browser-created and opener-retaining children to each source session", () => {
    const { owner, lifecycle } = family();
    const decision = owner.open(request("https://provider.example/login"));
    expect(decision.overrideBrowserWindowOptions?.webPreferences?.session).toBe(
      owner.contents.session,
    );
    const popup = child(owner, "https://provider.example/login");
    expect(popup.contents.session).not.toBe(owner.contents.session);
    const nested = popup.open(request("https://provider.example/consent"));
    expect(nested.overrideBrowserWindowOptions?.webPreferences?.session).toBe(
      popup.contents.session,
    );
    lifecycle.dispose();
  });

  it("allows blank -> provider -> callback without reloading the opener or child", () => {
    const { owner, lifecycle } = family();
    expect(owner.open().action).toBe("allow");
    const popup = child(owner);
    expect(popup.navigate("https://provider.example/login").preventDefault).not.toHaveBeenCalled();
    expect(popup.navigate("https://app.example/callback").preventDefault).not.toHaveBeenCalled();
    expect(owner.contents.getURL()).toBe("https://app.example");
    expect(owner.loadURL).not.toHaveBeenCalled();
    expect(popup.loadURL).not.toHaveBeenCalled();
    lifecycle.dispose();
  });

  it("reserves capacity synchronously before Electron creates the windows", () => {
    const { owner, lifecycle } = family();
    for (let index = 0; index < 4; index++) expect(owner.open().action).toBe("allow");
    expect(owner.open().action).toBe("deny");
    lifecycle.dispose();
  });

  it("bounds nested provider/consent chains and releases closed windows", () => {
    const { owner, lifecycle } = family();
    let opener = owner;
    const popups = [];
    for (let depth = 0; depth < 4; depth++) {
      expect(opener.open(request(`https://provider-${depth}.example`)).action).toBe("allow");
      const popup = child(opener, `https://provider-${depth}.example`);
      popups.push(popup);
      opener = popup;
    }
    expect(opener.open().action).toBe("deny");
    expect(owner.open().action).toBe("deny");
    popups[3]!.destroy();
    expect(owner.open().action).toBe("allow");
    lifecycle.dispose();
    expect(popups.every((popup) => popup.window.isDestroyed())).toBe(true);
  });

  it("bounds repeated open/close storms and renews the budget on a new owner document", () => {
    const { owner, lifecycle } = family();
    for (let index = 0; index < 16; index++) {
      expect(owner.open().action).toBe("allow");
      child(owner).destroy();
    }
    expect(owner.open().action).toBe("deny");
    owner.navigate("https://app.example/next");
    expect(owner.open().action).toBe("allow");
    lifecycle.dispose();
  });

  it.each([
    "javascript:alert(1)",
    "file:///etc/passwd",
    "data:text/html,hello",
    "vscode://vscode-remote/host",
    "goat://callback",
    "about:config",
    "https://user:password@provider.example",
    "invalid",
  ])("denies unsafe child creation, navigation, and redirects: %s", (url) => {
    const { owner, lifecycle } = family();
    expect(owner.open(request(url)).action).toBe("deny");
    expect(owner.open().action).toBe("allow");
    const popup = child(owner);
    expect(popup.open(request(url)).action).toBe("deny");
    expect(popup.navigate(url).preventDefault).toHaveBeenCalledOnce();
    const event = { preventDefault: vi.fn() };
    popup.events.emit("will-redirect", event, url);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    lifecycle.dispose();
  });

  it("requires a web origin for an initial blank child, inherited by a blank nested child", () => {
    const opaque = family("file:///tmp/page.html");
    expect(opaque.owner.open().action).toBe("deny");
    opaque.lifecycle.dispose();
    const { owner, lifecycle } = family();
    expect(owner.open().action).toBe("allow");
    const popup = child(owner);
    expect(popup.open().action).toBe("allow");
    child(popup);
    lifecycle.dispose();
  });

  it("preserves the POST request by allowing Electron to create the original child", () => {
    const { owner, lifecycle } = family();
    const details = {
      ...request("https://provider.example/consent"),
      postBody: { data: [], contentType: "application/x-www-form-urlencoded" },
    };
    const decision = owner.open(details);
    expect(decision.action).toBe("allow");
    expect(decision.createWindow).toBeUndefined();
    expect(decision.outlivesOpener).toBe(false);
    expect(owner.loadURL).not.toHaveBeenCalled();
    lifecycle.dispose();
  });

  it("destroys the family on owner destruction and removes all popup listeners", () => {
    const { owner, lifecycle } = family();
    expect(owner.open().action).toBe("allow");
    const popup = child(owner);
    expect(popup.open().action).toBe("allow");
    const consent = child(popup);
    owner.destroy();
    expect(popup.destroy).toHaveBeenCalledOnce();
    expect(consent.destroy).toHaveBeenCalledOnce();
    expect(popup.events.eventNames()).toEqual([]);
    expect(consent.events.eventNames()).toEqual([]);
    expect(owner.events.eventNames()).toEqual([]);
    expect(popup.open().action).toBe("deny");
    lifecycle.dispose();
  });

  it("destroys delayed children after the owner attachment has been disposed", () => {
    const { owner, lifecycle } = family();
    expect(owner.open().action).toBe("allow");
    // Keep the callback Electron already captured before listener removal.
    const created = owner.events.listeners("did-create-window")[0]!;
    lifecycle.dispose();
    const popup = child(owner);
    created(popup.window);
    expect(popup.window.isDestroyed()).toBe(true);
    expect(owner.open().action).toBe("deny");
  });
});
