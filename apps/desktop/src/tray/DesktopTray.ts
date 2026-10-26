import type { DesktopTrayMenu, DesktopTrayThread } from "@goat/contracts";
import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopAssets from "../app/DesktopAssets.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { SET_TRAY_MENU_CHANNEL, TRAY_OPEN_THREAD_CHANNEL } from "../ipc/channels.ts";
import * as DesktopIpc from "../ipc/DesktopIpc.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import { trayMenuTemplate } from "./trayMenu.ts";

const { logWarning } = makeComponentLogger("desktop-tray");

const TrayText = Schema.String.check(Schema.isMaxLength(1_000));
const TrayThreads = Schema.Array(
  Schema.Struct({
    environmentId: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200)),
    threadId: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200)),
    title: TrayText,
    project: Schema.NullOr(TrayText),
  }),
).check(Schema.isMaxLength(20));
const TrayMenuPayload = Schema.Struct({
  attention: TrayThreads,
  running: TrayThreads,
  pinned: TrayThreads,
});

const EMPTY_MENU: DesktopTrayMenu = { attention: [], running: [], pinned: [] };

class DesktopTrayCreateError extends Schema.TaggedError<DesktopTrayCreateError>()(
  "DesktopTrayCreateError",
  { cause: Schema.Defect() },
) {}

// The Template suffix makes macOS tint the mark for the menu bar; Windows and Linux get the
// app tile, which reads on light and dark taskbars alike.
function trayIconFile(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "tray/trayTemplate.png";
  if (platform === "win32") return "tray/tray.png";
  return "tray/tray-linux.png";
}

const createTray = Effect.fn("desktop.tray.create")(function* (
  platform: NodeJS.Platform,
  appName: string,
) {
  const assets = yield* DesktopAssets.DesktopAssets;
  const iconPath = yield* assets
    .resolveResourcePath(trayIconFile(platform))
    .pipe(Effect.orElseSucceed(() => Option.none<string>()));
  if (Option.isNone(iconPath)) {
    yield* logWarning("tray icon missing; tray disabled", { file: trayIconFile(platform) });
    return Option.none<Electron.Tray>();
  }
  return yield* Effect.acquireRelease(
    Effect.try({
      try: () => {
        const image = Electron.nativeImage.createFromPath(iconPath.value);
        if (platform === "darwin") image.setTemplateImage(true);
        const tray = new Electron.Tray(image);
        tray.setToolTip(appName);
        return tray;
      },
      catch: (cause) => new DesktopTrayCreateError({ cause }),
    }),
    (tray) =>
      Effect.sync(() => {
        if (!tray.isDestroyed()) tray.destroy();
      }),
  ).pipe(
    Effect.asSome,
    Effect.catch((error) =>
      logWarning("could not create tray; tray disabled", { cause: String(error.cause) }).pipe(
        Effect.as(Option.none<Electron.Tray>()),
      ),
    ),
  );
});

/** The menu-bar / notification-area icon listing threads the renderer reports. */
export const installDesktopTray = Effect.fn("desktop.tray.install")(function* () {
  const ipc = yield* DesktopIpc.DesktopIpc;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const electronApp = yield* ElectronApp.ElectronApp;
  const { platform, displayName } = environment;
  const tray = yield* createTray(platform, displayName);
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());

  const run = <E>(effect: Effect.Effect<void, E>, action: string) =>
    void runPromise(
      effect.pipe(
        Effect.catchCause((cause) => logWarning("tray action failed", { action, cause })),
      ),
    );
  // The renderer navigates itself, so a thread on a live remote environment opens even while
  // the local one is down. activate recreates a window macOS closed.
  const openThread = Effect.fn("desktop.tray.openThread")(function* (thread: DesktopTrayThread) {
    yield* desktopWindow.activate;
    const window = yield* electronWindow.currentMainOrFirst;
    if (Option.isNone(window) || window.value.isDestroyed()) return;
    const contents = window.value.webContents;
    const send = () => {
      if (!contents.isDestroyed()) {
        contents.send(TRAY_OPEN_THREAD_CHANNEL, {
          environmentId: thread.environmentId,
          threadId: thread.threadId,
        });
      }
    };
    if (contents.isLoadingMainFrame()) contents.once("did-finish-load", send);
    else send();
  });
  const actions = {
    openApp: () => run(desktopWindow.activate, "open-app"),
    openThread: (thread: DesktopTrayThread) => run(openThread(thread), "open-thread"),
    quit: () => run(electronApp.quit, "quit"),
  };

  let applied: string | null = null;
  const watched = new Set<number>();
  const apply = (menu: DesktopTrayMenu) => {
    if (Option.isNone(tray) || tray.value.isDestroyed()) return;
    const key = JSON.stringify(menu);
    if (key === applied) return;
    applied = key;
    tray.value.setContextMenu(
      Electron.Menu.buildFromTemplate(
        trayMenuTemplate({ menu, platform, appName: displayName, actions }),
      ),
    );
  };
  apply(EMPTY_MENU);
  // A left click on a Windows notification-area icon opens nothing by default.
  if (Option.isSome(tray) && platform === "win32") {
    const value = tray.value;
    value.on("click", () => value.popUpContextMenu());
  }

  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: SET_TRAY_MENU_CHANNEL,
      payload: TrayMenuPayload,
      result: Schema.Void,
      handler: (menu, event) =>
        Effect.sync(() => {
          apply(menu);
          // Rows go stale once their renderer is gone (macOS keeps running windowless).
          const senderId = event?.sender.id;
          const sender = senderId === undefined ? undefined : Electron.webContents.fromId(senderId);
          if (senderId !== undefined && sender && !watched.has(senderId)) {
            watched.add(senderId);
            sender.once("destroyed", () => {
              watched.delete(senderId);
              apply(EMPTY_MENU);
            });
          }
        }),
    }),
  );
});
