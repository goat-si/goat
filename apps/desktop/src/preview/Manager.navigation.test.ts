import { it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as NodeEvents from "node:events";
import { expect, vi } from "vite-plus/test";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopRendererHistory from "../telemetry/DesktopRendererHistory.ts";
import * as BrowserSession from "./BrowserSession.ts";
import * as DesktopBrowserHost from "./DesktopBrowserHost.ts";
import * as PreviewManager from "./Manager.ts";
import * as PreviewPasskeys from "./Passkeys.ts";

const { fromId } = vi.hoisted(() => ({ fromId: vi.fn() }));
vi.mock("electron", () => ({
  webContents: { fromId, getFocusedWebContents: vi.fn() },
  session: { fromPartition: vi.fn() },
  nativeImage: { createFromPath: vi.fn() },
  shell: { showItemInFolder: vi.fn() },
  clipboard: { write: vi.fn() },
}));
const layer = PreviewManager.layer.pipe(
  Layer.provideMerge(
    Layer.succeed(DesktopRendererHistory.DesktopRendererHistory, {
      register: () => Effect.void,
      recordMetrics: () => Effect.void,
      shutdown: Effect.void,
    }),
  ),
  Layer.provideMerge(DesktopBrowserHost.layer),
  Layer.provideMerge(
    Layer.succeed(
      BrowserSession.BrowserSession,
      BrowserSession.BrowserSession.of({
        getPartition: () => Effect.succeed("preview-test"),
        isPartition: () => true,
        getSession: () => Effect.succeed({ on: () => {} } as unknown as Electron.Session),
        clearCookies: () => Effect.void,
        clearCache: () => Effect.void,
      }),
    ),
  ),
  Layer.provideMerge(
    Layer.mock(PreviewPasskeys.PreviewPasskeys)({
      bridgeEnabled: false,
      installSessionHandlers: () => {},
      attachGuest: () => () => {},
    }),
  ),
  Layer.provideMerge(
    Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
      browserArtifactsDir: "/tmp/preview-artifacts",
      dirname: "/tmp/preview",
      path: { join: (...parts: string[]) => parts.join("/") },
    } as DesktopEnvironment.DesktopEnvironment["Service"]),
  ),
  Layer.provideMerge(FileSystem.layerNoop({})),
  Layer.provideMerge(Path.layer),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(Layer.succeed(HostProcess.Platform, "darwin")),
);

it.effect("accepts a redirect but rejects a load superseded by another navigate", () =>
  Effect.gen(function* () {
    const manager = yield* PreviewManager.PreviewManager;
    const started = Promise.withResolvers<void>();
    let rejectFirst: (error: Error) => void = () => {};
    const aborted = () => Object.assign(new Error("ERR_ABORTED"), { errno: -3 });
    const contents = Object.assign(new NodeEvents.EventEmitter(), {
      id: 42,
      isDestroyed: () => false,
      getType: () => "webview",
      getURL: () => "about:blank",
      getTitle: () => "",
      isLoadingMainFrame: () => false,
      isDevToolsOpened: () => false,
      getZoomFactor: () => 1,
      setZoomFactor: vi.fn(),
      setAudioMuted: vi.fn(),
      isCurrentlyAudible: () => false,
      send: vi.fn(),
      setIgnoreMenuShortcuts: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      isFocused: () => true,
      focusedFrame: {},
      ipc: new NodeEvents.EventEmitter(),
      session: { fetch: vi.fn() },
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      debugger: Object.assign(new NodeEvents.EventEmitter(), {
        isAttached: () => false,
        attach: vi.fn(),
        sendCommand: vi.fn(),
      }), // justified: Electron WebContents exposes this property.
      loadURL: vi.fn((url: string) => {
        contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false, url });
        if (url.endsWith("/first"))
          return new Promise<void>((_resolve, reject) => {
            rejectFirst = reject;
            contents.emit("did-redirect-navigation", {
              isMainFrame: true,
              isSameDocument: false,
              url: "https://example.com/first-redirect",
            });
            started.resolve();
          });
        if (url.endsWith("/redirect")) {
          contents.emit("will-navigate", {
            isMainFrame: true,
            isSameDocument: false,
            url: "https://example.com/target",
          });
          contents.emit("did-start-navigation", {
            isMainFrame: true,
            isSameDocument: false,
            url: "https://example.com/target",
          });
          return Promise.reject(aborted());
        }
        if (url.endsWith("/unload")) {
          contents.emit("did-redirect-navigation", { isMainFrame: true, isSameDocument: false });
          contents.emit("will-prevent-unload");
          return Promise.reject(aborted());
        }
        if (url.endsWith("/subframe")) {
          contents.emit("did-redirect-navigation", { isMainFrame: false, isSameDocument: false });
          return Promise.reject(aborted());
        }
        if (url.endsWith("/failed"))
          return Promise.reject(Object.assign(new Error("DNS"), { errno: -105 }));
        rejectFirst(aborted());
        return Promise.resolve();
      }),
    });
    fromId.mockReturnValue(contents);
    yield* manager.createTab("navigation-test");
    yield* manager.registerWebview("navigation-test", 42);
    const first = yield* Effect.forkChild(
      Effect.exit(manager.navigate("navigation-test", "https://example.com/first")),
    );
    yield* Effect.promise(() => started.promise);
    yield* manager.navigate("navigation-test", "https://example.com/second");
    expect(Exit.isFailure(yield* Fiber.join(first))).toBe(true);
    expect(
      Exit.isSuccess(
        yield* Effect.exit(manager.navigate("navigation-test", "https://example.com/redirect")),
      ),
    ).toBe(true);
    for (const name of ["unload", "subframe", "failed"]) {
      expect(
        Exit.isFailure(
          yield* Effect.exit(manager.navigate("navigation-test", `https://example.com/${name}`)),
        ),
      ).toBe(true);
    }
  }).pipe(Effect.provide(layer), Effect.scoped),
);
