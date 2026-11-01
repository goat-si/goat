/**
 * Popup adoption/navigation policy informed by Synara's browserManager.ts and
 * browserSessionPolicy.ts. GOAT retains native children, without its overlay host.
 *
 * MIT License
 * Copyright (c) 2026 T3 Tools Inc.
 * Copyright (c) 2026 Emanuele Di Pietro
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

const MAX_LIVE_POPUPS = 4;
const MAX_POPUP_DEPTH = 4;
const MAX_POPUPS_PER_DOCUMENT = 16;

// Electron can also report a javascript: window.open as about:blank. It is
// indistinguishable here from a blank child the same-origin opener can script.
export const isBlankPopupUrl = (url: string) => url === "" || url === "about:blank";

export const popupWebOrigin = (url: string): string | undefined => {
  try {
    const parsed = new URL(url);
    if (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      !parsed.username &&
      !parsed.password
    ) {
      return parsed.origin;
    }
  } catch {
    // Page-controlled invalid URLs cannot create native windows.
  }
  return undefined;
};

/**
 * Owns one preview guest's native popup family. Returning allow lets Electron
 * keep the original child, opener, POST body and profile session. Never reload
 * a child URL or publish a replacement preview tab here.
 */
export const createPreviewPopupLifecycle = (
  owner: Electron.WebContents,
  beforeInput: (contents: Electron.WebContents, input: Electron.Input) => void,
) => {
  const windows = new Map<Electron.BrowserWindow, () => void>();
  const pending = new Map<Electron.WebContents, Array<string>>();
  let creations = 0;
  let disposed = false;

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    owner.off("destroyed", dispose);
    owner.off("did-navigate", resetBudget);
    owner.off("did-create-window", rootWindowCreated);
    if (!owner.isDestroyed()) owner.setWindowOpenHandler(() => ({ action: "deny" }));
    pending.clear();
    // Destroy bypasses page beforeunload handlers when the owning tab is gone.
    for (const [window, detach] of windows) {
      detach();
      if (!window.isDestroyed()) window.destroy();
    }
    windows.clear();
  };
  const resetBudget = () => {
    creations = 0;
  };

  const open = (
    source: Electron.WebContents,
    depth: number,
    inheritedOrigin: string | undefined,
    details: Electron.HandlerDetails,
  ): Electron.WindowOpenHandlerResponse => {
    if (disposed || owner.isDestroyed() || source.isDestroyed()) return { action: "deny" };
    const origin = isBlankPopupUrl(source.getURL())
      ? inheritedOrigin
      : popupWebOrigin(source.getURL());
    const targetOrigin = isBlankPopupUrl(details.url) ? origin : popupWebOrigin(details.url);
    const reserved = [...pending.values()].reduce((count, requests) => count + requests.length, 0);
    if (
      !targetOrigin ||
      depth >= MAX_POPUP_DEPTH ||
      windows.size + reserved >= MAX_LIVE_POPUPS ||
      creations >= MAX_POPUPS_PER_DOCUMENT
    ) {
      return { action: "deny" };
    }
    creations += 1;
    const requests = pending.get(source) ?? [];
    requests.push(targetOrigin);
    pending.set(source, requests);
    return {
      action: "allow",
      outlivesOpener: false,
      overrideBrowserWindowOptions: {
        autoHideMenuBar: true,
        // Electron accepts undefined to clear a preload; its exact optional
        // TypeScript field only admits strings when present.
        // @ts-expect-error Explicitly clear any opener preload.
        webPreferences: {
          // Browser-created children (e.g. noopener POSTs) may have no inherited
          // WebContents. Pin their cookies and profile to the source session.
          session: source.session,
          // Popups are provider pages, not preview guests. Electron applies
          // these overrides before creating even an opener-retaining blank
          // child, whose initial realm can still share the opener's world.
          // Never carry the guest's pick/annotation/passkey bridge in.
          preload: undefined,
          additionalArguments: [],
          contextIsolation: true,
          nodeIntegration: false,
          nodeIntegrationInSubFrames: false,
          nodeIntegrationInWorker: false,
          sandbox: true,
          webviewTag: false,
        },
      },
    };
  };

  const adopt = (source: Electron.WebContents, depth: number, window: Electron.BrowserWindow) => {
    const requests = pending.get(source);
    const inheritedOrigin = requests?.shift();
    if (!requests?.length) pending.delete(source);
    if (disposed || !inheritedOrigin || owner.isDestroyed()) {
      if (!window.isDestroyed()) window.destroy();
      return;
    }
    const contents = window.webContents;
    const childCreated = (child: Electron.BrowserWindow) => adopt(contents, depth + 1, child);
    const input = (_event: Electron.Event, value: Electron.Input) => beforeInput(contents, value);
    const blockUnsafeNavigation = (event: Electron.Event, url: string) => {
      // Blank documents inherit their creator's origin. HTTP(S) may change
      // origins for provider -> consent -> callback; Chromium enforces SOP.
      if (!isBlankPopupUrl(url) && !popupWebOrigin(url)) event.preventDefault();
    };
    const closed = () => {
      detach();
      windows.delete(window);
      pending.delete(contents);
    };
    const detach = () => {
      contents.off("will-navigate", blockUnsafeNavigation);
      contents.off("will-redirect", blockUnsafeNavigation);
      contents.off("did-create-window", childCreated);
      contents.off("before-input-event", input);
      window.off("closed", closed);
    };
    windows.set(window, detach);
    contents.setIgnoreMenuShortcuts(true);
    contents.setWindowOpenHandler((details) => open(contents, depth, inheritedOrigin, details));
    contents.on("will-navigate", blockUnsafeNavigation);
    contents.on("will-redirect", blockUnsafeNavigation);
    contents.on("did-create-window", childCreated);
    contents.on("before-input-event", input);
    window.once("closed", closed);
  };
  const rootWindowCreated = (window: Electron.BrowserWindow) => adopt(owner, 1, window);
  owner.on("destroyed", dispose);
  owner.on("did-navigate", resetBudget);
  owner.on("did-create-window", rootWindowCreated);

  return {
    open: (details: Electron.HandlerDetails) => open(owner, 0, undefined, details),
    dispose,
  };
};
