import { DesktopCuaGrants, DesktopCuaVerification } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Electron from "electron";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopLifecycle from "../../app/DesktopLifecycle.ts";
import { ComputerUseHelperError } from "../../cua/ComputerUseHelper.ts";
import * as DesktopCuaDriver from "../../cua/DesktopCuaDriver.ts";
import * as ElectronShell from "../../electron/ElectronShell.ts";
import * as MacPermissions from "../../permissions/MacPermissions.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const restartCuaDriver = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.RESTART_CUA_DRIVER_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.cua.restart")(function* () {
    yield* (yield* DesktopCuaDriver.DesktopCuaDriver).restart;
  }),
});

export const verifyCuaDriver = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.VERIFY_CUA_DRIVER_CHANNEL,
  payload: Schema.Void,
  result: DesktopCuaVerification,
  handler: Effect.fn("desktop.ipc.cua.verify")(function* () {
    return yield* (yield* DesktopCuaDriver.DesktopCuaDriver).verify;
  }),
});

export const checkCuaGrants = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CHECK_CUA_GRANTS_CHANNEL,
  payload: Schema.Void,
  result: DesktopCuaGrants,
  handler: Effect.fn("desktop.ipc.cua.grants")(function* () {
    return yield* (yield* DesktopCuaDriver.DesktopCuaDriver).grants;
  }),
});

export const openCuaPermissionGuide = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OPEN_CUA_PERMISSION_GUIDE_CHANNEL,
  payload: Schema.Literals(["accessibility", "screen-recording"]),
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.cua.openPermissionGuide")(function* (pane) {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    if (environment.platform !== "darwin") return false;
    const owner = Electron.BrowserWindow.getFocusedWindow();
    const target = yield* (yield* DesktopCuaDriver.DesktopCuaDriver).grantTarget;
    // A broken helper is the only app that may hold the grants, so there is nothing to drag.
    if (target.kind === "unusable")
      return yield* Effect.fail(new ComputerUseHelperError("helperUnusable", target.message));
    const opened = yield* (yield* ElectronShell.ElectronShell).openSystemSettings(pane);
    if (!opened) return false;
    const key = pane === "accessibility" ? "accessibility" : "screenRecording";
    yield* (yield* MacPermissions.MacPermissions).showHelper(
      pane,
      owner,
      () => target.read().then((grants) => grants[key]),
      target.kind === "helper" ? { bundlePath: target.bundlePath, name: target.name } : undefined,
    );
    return true;
  }),
});

export const relaunchForCuaGrants = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.RELAUNCH_FOR_CUA_GRANTS_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.cua.relaunchForGrants")(function* () {
    yield* (yield* DesktopLifecycle.DesktopLifecycle).relaunch("computerUseGrants");
  }),
});

export const revealCuaGrantTarget = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.REVEAL_CUA_GRANT_TARGET_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.cua.revealGrantTarget")(function* () {
    const target = yield* (yield* DesktopCuaDriver.DesktopCuaDriver).grantTarget;
    if (target.kind === "unusable")
      return yield* Effect.fail(new ComputerUseHelperError("helperUnusable", target.message));
    const bundle =
      target.kind === "helper"
        ? target.bundlePath
        : /^(.+\.app)\/Contents\/MacOS\/[^/]+$/.exec(Electron.app.getPath("exe"))?.[1];
    if (bundle) Electron.shell.showItemInFolder(bundle);
  }),
});
