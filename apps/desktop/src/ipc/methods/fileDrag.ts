import { EnvironmentId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Electron from "electron";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopBackendManager from "../../backend/DesktopBackendManager.ts";
import * as DesktopBackendPool from "../../backend/DesktopBackendPool.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import { START_FILE_DRAG_CHANNEL } from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

export const startFileDrag = makeIpcMethod({
  channel: START_FILE_DRAG_CHANNEL,
  payload: Schema.Struct({ environmentId: EnvironmentId, path: Schema.String }),
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.fileDrag.start")(function* (input, event) {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    if (
      environment.platform !== "darwin" ||
      !input.path.startsWith("/") ||
      input.path.startsWith("//") ||
      input.path.includes("\0")
    ) {
      return false;
    }

    const desktopWindow = yield* ElectronWindow.ElectronWindow;
    const main = yield* desktopWindow.main;
    if (Option.isNone(main) || event?.sender !== main.value.webContents) return false;
    const contents = main.value.webContents;
    const frame = contents.mainFrame;

    const settings = yield* (yield* DesktopAppSettings.DesktopAppSettings).get;
    if (!settings.localEnvironmentEnabled) return false;
    const pool = yield* DesktopBackendPool.DesktopBackendPool;
    const primary = yield* pool.get(DesktopBackendManager.PRIMARY_INSTANCE_ID);
    if (Option.isNone(primary) || !(yield* primary.value.snapshot).ready) return false;

    const fs = yield* FileSystem.FileSystem;
    const hostEnvironmentId = yield* fs
      .readFileString(environment.path.join(environment.stateDir, "environment-id"))
      .pipe(
        Effect.map((id) => id.trim()),
        Effect.orElseSucceed(() => null),
      );
    if (input.environmentId !== hostEnvironmentId) return false;

    return yield* Effect.gen(function* () {
      const file = yield* fs.realPath(input.path);
      if ((yield* fs.stat(file)).type !== "File") return false;
      const icon = yield* Effect.tryPromise(() =>
        Electron.app.getFileIcon(file, { size: "normal" }),
      );
      const activeMain = yield* desktopWindow.main;
      return yield* Effect.try(() => {
        if (
          Option.isNone(activeMain) ||
          activeMain.value !== main.value ||
          contents.isDestroyed() ||
          contents.mainFrame !== frame
        ) {
          return false;
        }
        contents.startDrag({ file, icon });
        return true;
      });
    }).pipe(Effect.orElseSucceed(() => false));
  }),
});
