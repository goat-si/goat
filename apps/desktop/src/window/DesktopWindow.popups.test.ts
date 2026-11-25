import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as Electron from "electron";
import { vi } from "vite-plus/test";

import * as DesktopWindow from "./DesktopWindow.ts";
import { makeFakeBrowserWindow } from "./DesktopWindow.test-fixtures.ts";
import { layerTest } from "./DesktopWindow.testkit.ts";

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

it.effect("opens only web links from popups and declines external-protocol navigations", () =>
  Effect.gen(function* () {
    const fakeWindow = makeFakeBrowserWindow();
    const openedExternalUrls: unknown[] = [];
    const layer = layerTest({
      window: fakeWindow.window,
      createCount: yield* Ref.make(0),
      mainWindow: yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none()),
      openedExternalUrls,
    });

    yield* Effect.gen(function* () {
      const desktopWindow = yield* DesktopWindow.DesktopWindow;
      yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

      const openHandler = vi.mocked(fakeWindow.window.webContents.setWindowOpenHandler).mock
        .lastCall?.[0];
      if (!openHandler) {
        return yield* Effect.die("window open handler was not registered");
      }
      for (const url of [
        "vscode://file/home/user/project/readme.md",
        "vscode://vscode-remote/ssh-remote+remote.example/home/user/project",
        "zed://ssh/remote.example/home/user/project",
        "jetbrains://gateway/ssh/environment?h=remote.example",
        "grokbot://app/v1/prompt?text=hi",
        "https://example.com/docs",
      ]) {
        assert.deepEqual(openHandler({ url } as Electron.HandlerDetails), { action: "deny" }, url);
      }
      yield* Effect.promise(() => Promise.resolve());

      assert.deepEqual(openedExternalUrls, ["https://example.com/docs"]);

      const answerPermission = vi.mocked(
        fakeWindow.window.webContents.session.setPermissionRequestHandler,
      ).mock.lastCall?.[0];
      if (!answerPermission) {
        return yield* Effect.die("permission request handler was not registered");
      }
      const answers = (["openExternal", "media"] as const).map((permission) => {
        const callback = vi.fn();
        answerPermission(fakeWindow.window.webContents, permission, callback, {
          isMainFrame: false,
          requestingUrl: "http://127.0.0.1:3773/api/assets/token/page.html",
        });
        return callback.mock.lastCall?.[0];
      });
      assert.deepEqual(answers, [false, true]);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("forces preview guests to run the app's own preload", () =>
  Effect.gen(function* () {
    const fakeWindow = makeFakeBrowserWindow();
    const layer = layerTest({
      window: fakeWindow.window,
      createCount: yield* Ref.make(0),
      mainWindow: yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none()),
    });

    yield* Effect.gen(function* () {
      const desktopWindow = yield* DesktopWindow.DesktopWindow;
      yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

      const willAttachWebview = fakeWindow.webContentsListeners.get("will-attach-webview");
      if (!willAttachWebview) {
        return yield* Effect.die("will-attach-webview listener was not registered");
      }
      const webPreferences: Electron.WebPreferences = { preload: "/repo/elsewhere/other.cjs" };
      willAttachWebview({ preventDefault: () => {} }, webPreferences, {
        partition: "persist:t3code-preview-test",
      });

      assert.equal(
        webPreferences.preload,
        "/repo/apps/desktop/dist-electron/preview-pick-preload.cjs",
      );
      assert.isTrue(webPreferences.contextIsolation);
    }).pipe(Effect.provide(layer));
  }),
);
