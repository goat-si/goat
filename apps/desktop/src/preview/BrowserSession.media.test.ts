import { assert, describe, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as NodeEvents from "node:events";
import { beforeEach, vi } from "vite-plus/test";

const { fromPartition, sessions } = vi.hoisted(() => ({
  fromPartition: vi.fn(),
  sessions: new Map<
    string,
    {
      readonly clearCache: ReturnType<typeof vi.fn>;
      readonly clearStorageData: ReturnType<typeof vi.fn>;
      readonly closeAllConnections: ReturnType<typeof vi.fn>;
      readonly storagePath: string | null;
      readonly getUserAgent: ReturnType<typeof vi.fn<() => string>>;
      readonly setPermissionRequestHandler: ReturnType<typeof vi.fn>;
      readonly setPermissionCheckHandler: ReturnType<typeof vi.fn>;
      readonly setUserAgent: ReturnType<typeof vi.fn>;
      readonly webRequest: { readonly onBeforeSendHeaders: ReturnType<typeof vi.fn> };
    }
  >(),
}));

const { fromWebContents } = vi.hoisted(() => ({
  fromWebContents: vi.fn<(webContents: unknown) => unknown>(() => null),
}));

const { appListeners } = vi.hoisted(() => ({
  appListeners: new Map<string, (...args: unknown[]) => void>(),
}));

const { getMediaAccessStatus, askForMediaAccess } = vi.hoisted(() => ({
  getMediaAccessStatus: vi.fn<(device: string) => string>(() => "granted"),
  askForMediaAccess: vi.fn<(device: string) => Promise<boolean>>(() => Promise.resolve(true)),
}));

vi.mock("electron", () => ({
  app: {
    on: (eventName: string, listener: (...args: unknown[]) => void) => {
      appListeners.set(eventName, listener);
    },
    removeListener: (eventName: string) => {
      appListeners.delete(eventName);
    },
  },
  BrowserWindow: { fromWebContents },
  session: {
    fromPartition,
  },
  systemPreferences: { getMediaAccessStatus, askForMediaAccess },
}));

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as BrowserSession from "./BrowserSession.ts";

const { showMessageBox, showErrorBox } = vi.hoisted(() => ({
  showMessageBox: vi.fn<
    (
      options: Electron.MessageBoxOptions,
      owner?: Electron.BrowserWindow,
    ) => number | Promise<number>
  >(() => 1),
  showErrorBox: vi.fn<(title: string, content: string) => void>(),
}));
const layerDialog = Layer.succeed(ElectronDialog.ElectronDialog, {
  pickFolder: () => Effect.die("unused"),
  pickFiles: () => Effect.die("unused"),
  showMessageBox: (options, owner) =>
    Effect.promise(async () => ({
      response: await showMessageBox(options, owner),
      checkboxChecked: false,
    })),
  showErrorBox: (title, content) => Effect.sync(() => showErrorBox(title, content)),
});
const layer = BrowserSession.layer.pipe(
  Layer.provide(
    Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, layerDialog, ElectronApp.layer),
  ),
);

const layerDarwin = BrowserSession.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      NodeServices.layer,
      NodeCrypto.layer,
      layerDialog,
      ElectronApp.layer,
      Layer.succeed(HostProcess.Platform, "darwin"),
    ),
  ),
);

describe("BrowserSession media permissions", () => {
  beforeEach(() => {
    sessions.clear();
    appListeners.clear();
    showErrorBox.mockReset();
    fromPartition.mockReset();
    fromPartition.mockImplementation((partition: string) => {
      const browserSession = {
        clearCache: vi.fn(() => Promise.resolve()),
        clearStorageData: vi.fn(() => Promise.resolve()),
        closeAllConnections: vi.fn(() => Promise.resolve()),
        storagePath: null,
        getUserAgent: vi.fn(() => "Mozilla/5.0 Electron/41.5.0 t3code/0.0.27"), // goat-rename: legacy
        setPermissionRequestHandler: vi.fn(),
        setPermissionCheckHandler: vi.fn(),
        setUserAgent: vi.fn(),
        webRequest: { onBeforeSendHeaders: vi.fn() },
      };
      sessions.set(partition, browserSession);
      return browserSession;
    });
  });

  it.effect("asks once per origin and device before a page uses the camera", () =>
    Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;
      const partition = yield* browserSessions.getPartition("scope-a");
      yield* browserSessions.getSession("scope-a");
      const browserSession = sessions.get(partition);
      assert.isDefined(browserSession);
      const requestHandler = browserSession.setPermissionRequestHandler.mock.calls[0]?.[0];
      const checkHandler = browserSession.setPermissionCheckHandler.mock.calls[0]?.[0];

      const requestMedia = (requestingUrl: string, mediaTypes: ReadonlyArray<string>) =>
        Effect.callback<boolean>((resume) => {
          requestHandler(null, "media", (granted: boolean) => resume(Effect.succeed(granted)), {
            requestingUrl,
            securityOrigin: requestingUrl,
            mediaTypes,
            isMainFrame: true,
          });
        });
      const checkMedia = (origin: string, mediaType: string): boolean =>
        checkHandler(null, "media", origin, { mediaType }) as boolean;

      showMessageBox.mockReset();
      showMessageBox.mockReturnValueOnce(0).mockReturnValueOnce(1).mockReturnValueOnce(1);
      getMediaAccessStatus.mockReturnValue("granted");

      assert.isFalse(checkMedia("https://allowed.test", "video"));
      assert.isTrue(yield* requestMedia("https://allowed.test/scan", ["video"]));
      assert.strictEqual(
        showMessageBox.mock.calls[0]?.[0].message,
        "https://allowed.test wants to use your camera",
      );
      assert.isTrue(yield* requestMedia("https://allowed.test/again", ["video"]));
      assert.isTrue(checkMedia("https://allowed.test", "video"));
      assert.isFalse(checkMedia("https://allowed.test", "audio"));
      assert.strictEqual(showMessageBox.mock.calls.length, 1);

      assert.isFalse(yield* requestMedia("https://blocked.test/", ["video", "audio"]));
      assert.isFalse(yield* requestMedia("https://blocked.test/", ["audio"]));
      assert.isFalse(checkMedia("https://blocked.test", "video"));
      assert.strictEqual(showMessageBox.mock.calls.length, 2);

      assert.isFalse(yield* requestMedia("https://allowed.test/", ["video", "audio"]));
      assert.strictEqual(
        showMessageBox.mock.calls[2]?.[0].message,
        "https://allowed.test wants to use your microphone",
      );
      assert.isTrue(yield* requestMedia("https://allowed.test/", ["video"]));
      assert.isTrue(checkMedia("https://allowed.test", "video"));
      assert.isFalse(yield* requestMedia("https://allowed.test/", []));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("asks macOS for the device after the user allows a page", () =>
    Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;
      const partition = yield* browserSessions.getPartition("scope-a");
      yield* browserSessions.getSession("scope-a");
      const requestHandler =
        sessions.get(partition)?.setPermissionRequestHandler.mock.calls[0]?.[0];
      assert.isFunction(requestHandler);
      const requestMedia = (requestingUrl: string, mediaTypes: ReadonlyArray<string>) =>
        Effect.callback<boolean>((resume) => {
          requestHandler(null, "media", (granted: boolean) => resume(Effect.succeed(granted)), {
            requestingUrl,
            securityOrigin: requestingUrl,
            mediaTypes,
            isMainFrame: true,
          });
        });

      showMessageBox.mockReset();
      showMessageBox.mockReturnValue(0);
      askForMediaAccess.mockReset();
      askForMediaAccess.mockResolvedValue(true);
      getMediaAccessStatus.mockReset();
      getMediaAccessStatus.mockReturnValue("not-determined");

      // A device macOS has not decided yet: ask the OS, which adds GOAT to Privacy & Security.
      assert.isTrue(yield* requestMedia("https://first.test/", ["video"]));
      assert.deepStrictEqual(askForMediaAccess.mock.calls, [["camera"]]);
      assert.strictEqual(showMessageBox.mock.calls.length, 1);

      // macOS denied one of two devices: the page gets nothing and the user learns where to fix it.
      askForMediaAccess.mockReset();
      getMediaAccessStatus.mockImplementation((device) =>
        device === "camera" ? "not-determined" : "denied",
      );
      const recoveryShown = yield* Deferred.make<void>();
      const recoveryAnswer = Promise.withResolvers<number>();
      showMessageBox.mockImplementation((options) => {
        if (options.message.startsWith("macOS blocked")) {
          Deferred.doneUnsafe(recoveryShown, Effect.void);
          return recoveryAnswer.promise;
        }
        return 0;
      });
      assert.isFalse(yield* requestMedia("https://second.test/", ["video", "audio"]));
      assert.strictEqual(askForMediaAccess.mock.calls.length, 0);
      yield* Deferred.await(recoveryShown);
      assert.strictEqual(showMessageBox.mock.calls.length, 3);
      assert.strictEqual(
        showMessageBox.mock.calls[1]?.[0].message,
        "https://second.test wants to use your camera and microphone",
      );
      // Only the microphone is blocked, so the message does not send the user looking for Camera.
      assert.strictEqual(
        showMessageBox.mock.calls[2]?.[0].message,
        "macOS blocked GOAT from using your microphone",
      );
      assert.isFalse(yield* requestMedia("https://second.test/", ["video", "audio"]));
      assert.strictEqual(showMessageBox.mock.calls.length, 3);
      recoveryAnswer.resolve(0);
      const checkHandler = sessions.get(partition)?.setPermissionCheckHandler.mock.calls[0]?.[0];
      assert.isFalse(checkHandler(null, "media", "https://second.test", { mediaType: "audio" }));
      getMediaAccessStatus.mockReturnValue("granted");
      assert.isTrue(checkHandler(null, "media", "https://second.test", { mediaType: "audio" }));
    }).pipe(Effect.provide(layerDarwin)),
  );

  it.effect("names both devices when macOS blocks both", () =>
    Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;
      const partition = yield* browserSessions.getPartition("scope-a");
      yield* browserSessions.getSession("scope-a");
      const requestHandler =
        sessions.get(partition)?.setPermissionRequestHandler.mock.calls[0]?.[0];
      assert.isFunction(requestHandler);

      askForMediaAccess.mockReset();
      getMediaAccessStatus.mockReset();
      getMediaAccessStatus.mockReturnValue("denied");
      const recoveryShown = yield* Deferred.make<string>();
      showMessageBox.mockReset();
      showMessageBox.mockImplementation((options) => {
        if (options.message.startsWith("macOS blocked")) {
          Deferred.doneUnsafe(recoveryShown, Effect.succeed(options.message));
        }
        return 0;
      });

      const granted = yield* Effect.callback<boolean>((resume) => {
        requestHandler(null, "media", (value: boolean) => resume(Effect.succeed(value)), {
          requestingUrl: "https://both.test/",
          mediaTypes: ["video", "audio"],
          isMainFrame: true,
        });
      });
      assert.isFalse(granted);
      assert.strictEqual(askForMediaAccess.mock.calls.length, 0);
      assert.strictEqual(
        yield* Deferred.await(recoveryShown),
        "macOS blocked GOAT from using your camera and microphone",
      );
    }).pipe(Effect.provide(layerDarwin)),
  );

  it.effect("forgets camera answers when the profile's cookies are cleared", () =>
    Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;
      const partition = yield* browserSessions.getPartition("scope-a");
      yield* browserSessions.getSession("scope-a");
      const browserSession = sessions.get(partition);
      assert.isDefined(browserSession);
      const requestHandler = browserSession.setPermissionRequestHandler.mock.calls[0]?.[0];
      const checkHandler = browserSession.setPermissionCheckHandler.mock.calls[0]?.[0];
      const requestCamera = () =>
        Effect.callback<boolean>((resume) => {
          requestHandler(null, "media", (granted: boolean) => resume(Effect.succeed(granted)), {
            requestingUrl: "https://page.test/",
            mediaTypes: ["video"],
            isMainFrame: true,
          });
        });
      const checkCamera = (): boolean =>
        checkHandler(null, "media", "https://page.test", { mediaType: "video" }) as boolean;

      showMessageBox.mockReset();
      showMessageBox.mockReturnValueOnce(1).mockReturnValueOnce(0).mockReturnValueOnce(1);
      getMediaAccessStatus.mockReset();
      getMediaAccessStatus.mockReturnValue("granted");

      assert.isFalse(yield* requestCamera());
      assert.isFalse(yield* requestCamera());
      assert.strictEqual(showMessageBox.mock.calls.length, 1);

      // Clearing lets the user reconsider a block...
      yield* browserSessions.clearCookies([partition]);
      assert.isTrue(yield* requestCamera());
      assert.isTrue(checkCamera());
      assert.strictEqual(showMessageBox.mock.calls.length, 2);

      // ...and revokes an approval, including one cleared outside clearCookies.
      yield* browserSessions.cookiesCleared(browserSession as unknown as Electron.Session);
      assert.isFalse(checkCamera());
      assert.isFalse(yield* requestCamera());
      assert.strictEqual(showMessageBox.mock.calls.length, 3);

      yield* browserSessions.clearCookies([partition]);
      showMessageBox.mockReturnValue(0);
      assert.isTrue(yield* requestCamera());
      yield* browserSessions.getSession("scope-b");
      const otherPartition = yield* browserSessions.getPartition("scope-b");
      const otherRequest =
        sessions.get(otherPartition)?.setPermissionRequestHandler.mock.calls[0]?.[0];
      const otherCheck = sessions.get(otherPartition)?.setPermissionCheckHandler.mock.calls[0]?.[0];
      assert.isTrue(
        yield* Effect.callback<boolean>((resume) => {
          otherRequest(null, "media", (value: boolean) => resume(Effect.succeed(value)), {
            requestingUrl: "https://page.test/",
            mediaTypes: ["video"],
            isMainFrame: true,
          });
        }),
      );
      browserSession.clearStorageData.mockRejectedValueOnce(new Error("clear failed"));
      const pendingClear = Promise.withResolvers<void>();
      sessions
        .get(otherPartition)
        ?.clearStorageData.mockImplementationOnce(() => pendingClear.promise);
      const cleared = yield* Effect.result(browserSessions.clearCookies());
      assert.strictEqual(cleared._tag, "Failure");
      assert.isFalse(checkCamera());
      assert.isFalse(otherCheck(null, "media", "https://page.test", { mediaType: "video" }));
      pendingClear.resolve();
    }).pipe(Effect.provide(layer)),
  );

  it.effect("a reset while a camera prompt is open neither grants nor remembers", () =>
    Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;
      const partition = yield* browserSessions.getPartition("scope-a");
      yield* browserSessions.getSession("scope-a");
      const requestHandler =
        sessions.get(partition)?.setPermissionRequestHandler.mock.calls[0]?.[0];
      const checkHandler = sessions.get(partition)?.setPermissionCheckHandler.mock.calls[0]?.[0];
      const guest = Object.assign(new NodeEvents.EventEmitter(), {
        hostWebContents: null,
        isDestroyed: vi.fn<() => boolean>(() => false),
      });
      const requestCamera = () => {
        const granted = Deferred.makeUnsafe<boolean>();
        requestHandler(
          guest,
          "media",
          (value: boolean) => Deferred.doneUnsafe(granted, Effect.succeed(value)),
          { requestingUrl: "https://page.test/", mediaTypes: ["video"], isMainFrame: true },
        );
        return Deferred.await(granted);
      };
      const checkCamera = (): boolean =>
        checkHandler(null, "media", "https://page.test", { mediaType: "video" }) as boolean;

      // The user answers Allow only after cookies were cleared.
      const asked = yield* Deferred.make<void>();
      const answer = Promise.withResolvers<number>();
      showMessageBox.mockReset();
      showMessageBox.mockImplementationOnce(() => {
        Deferred.doneUnsafe(asked, Effect.void);
        return answer.promise;
      });
      getMediaAccessStatus.mockReset();
      getMediaAccessStatus.mockReturnValue("not-determined");
      askForMediaAccess.mockReset();
      askForMediaAccess.mockResolvedValue(true);

      const pending = yield* Effect.forkChild(requestCamera());
      yield* Deferred.await(asked);
      yield* browserSessions.clearCookies([partition]);
      answer.resolve(0);
      assert.isFalse(yield* Fiber.join(pending));
      // With macOS allowing the camera, only a stored stale Allow could make this check pass.
      getMediaAccessStatus.mockReturnValue("granted");
      assert.isFalse(checkCamera());
      getMediaAccessStatus.mockReturnValue("not-determined");
      assert.strictEqual(askForMediaAccess.mock.calls.length, 0);

      // The macOS check is still running when cookies are cleared.
      const systemAsked = yield* Deferred.make<void>();
      const systemAnswer = Promise.withResolvers<boolean>();
      showMessageBox.mockReturnValue(0);
      askForMediaAccess.mockImplementationOnce(() => {
        Deferred.doneUnsafe(systemAsked, Effect.void);
        return systemAnswer.promise;
      });
      const pendingSystem = yield* Effect.forkChild(requestCamera());
      yield* Deferred.await(systemAsked);
      yield* browserSessions.clearCookies([partition]);
      systemAnswer.resolve(true);
      assert.isFalse(yield* Fiber.join(pendingSystem));
      assert.isFalse(checkCamera());

      const tabPromptShown = yield* Deferred.make<void>();
      const tabAnswer = Promise.withResolvers<number>();
      showMessageBox.mockImplementationOnce(() => {
        Deferred.doneUnsafe(tabPromptShown, Effect.void);
        return tabAnswer.promise;
      });
      const pendingTab = yield* Effect.forkChild(requestCamera());
      yield* Deferred.await(tabPromptShown);
      const promptSignal = showMessageBox.mock.lastCall?.[0].signal;
      guest.isDestroyed.mockReturnValue(true);
      guest.emit("destroyed");
      assert.isTrue(promptSignal?.aborted);
      tabAnswer.resolve(0);
      assert.isFalse(yield* Fiber.join(pendingTab));
      assert.isFalse(checkCamera());
      assert.strictEqual(askForMediaAccess.mock.calls.length, 1);
    }).pipe(Effect.provide(layerDarwin)),
  );
});
