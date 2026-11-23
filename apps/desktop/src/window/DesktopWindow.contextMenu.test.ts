import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import type * as ElectronMenu from "../electron/ElectronMenu.ts";
import * as DesktopWindow from "./DesktopWindow.ts";
import { makeFakeBrowserWindow } from "./DesktopWindow.test-fixtures.ts";
import { layerTest } from "./DesktopWindow.testkit.ts";
import { vi } from "vite-plus/test";

vi.mock("electron", async (importOriginal) => ({
  ...(await importOriginal<typeof import("electron")>()),
  session: {
    fromPartition: vi.fn(() => ({
      getUserAgent: vi.fn(() => "Electron"),
      setPermissionRequestHandler: vi.fn(),
      setUserAgent: vi.fn(),
    })),
  },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  screen: {
    on: vi.fn(),
    removeListener: vi.fn(),
    getAllDisplays: vi.fn(() => [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }]),
  },
}));

it.effect("reloads only the browser page selected through its context menu", () =>
  Effect.gen(function* () {
    const main = makeFakeBrowserWindow();
    const guest = makeFakeBrowserWindow();
    const otherGuest = makeFakeBrowserWindow();
    const popup = makeFakeBrowserWindow();
    const createCount = yield* Ref.make(0);
    const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
    const menus = yield* Queue.unbounded<ElectronMenu.ElectronMenuTemplateInput>();

    yield* Effect.gen(function* () {
      const desktopWindow = yield* DesktopWindow.DesktopWindow;
      yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

      const attach = main.webContentsListeners.get("did-attach-webview");
      if (!attach) return yield* Effect.die("did-attach-webview listener was not registered");
      attach({}, guest.window.webContents);
      attach({}, otherGuest.window.webContents);
      const openPopup = guest.webContentsListeners.get("did-create-window");
      if (!openPopup) return yield* Effect.die("did-create-window listener was not registered");
      openPopup(popup.window, { frameName: "" });

      const pages = [main, guest, otherGuest, popup];
      for (const page of pages) {
        const contextMenu = page.webContentsListeners.get("context-menu");
        if (!contextMenu) return yield* Effect.die("context-menu listener was not registered");
        contextMenu(
          { preventDefault: vi.fn() },
          {
            misspelledWord: "",
            linkURL: "",
            mediaType: "none",
            editFlags: { canCut: false, canCopy: true, canPaste: false, canSelectAll: true },
          },
        );
        const menu = yield* Queue.take(menus);
        assert.deepEqual(
          menu.template.filter((item) => item.role).map((item) => [item.role, item.enabled]),
          [
            ["cut", false],
            ["copy", true],
            ["paste", false],
            ["selectAll", true],
          ],
        );
        const reload = menu.template.find((item) => item.label === "Reload");
        if (page === main) {
          assert.isUndefined(reload);
          continue;
        }
        if (!reload?.click) return yield* Effect.die("browser context menu has no Reload action");
        assert.isUndefined(reload.accelerator);
        reload.click({} as Electron.MenuItem, main.window, {} as KeyboardEvent);
        assert.equal(page.reload.mock.calls.length, 1);
        for (const otherPage of pages) {
          if (otherPage !== page) assert.equal(otherPage.reload.mock.calls.length, 0);
        }
        vi.mocked(page.window.webContents.isDestroyed).mockReturnValue(true);
        reload.click({} as Electron.MenuItem, main.window, {} as KeyboardEvent);
        assert.equal(page.reload.mock.calls.length, 1);
        page.reload.mockClear();
      }
    }).pipe(
      Effect.provide(
        layerTest({
          window: main.window,
          createCount,
          mainWindow,
          onPopupTemplate: (menu) => Queue.offer(menus, menu).pipe(Effect.asVoid),
        }),
      ),
    );
  }),
);
