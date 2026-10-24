import { DesktopWindowMaterialState } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopWindowMaterial from "../../window/material/DesktopWindowMaterial.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import { GET_WINDOW_MATERIAL_STATE_CHANNEL } from "../channels.ts";

export const getWindowMaterialState = DesktopIpc.makeIpcMethod({
  channel: GET_WINDOW_MATERIAL_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopWindowMaterialState,
  handler: Effect.fn("desktop.ipc.windowMaterial.get")(function* (_input, event) {
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const material = yield* DesktopWindowMaterial.DesktopWindowMaterial;
    const main = yield* electronWindow.main;
    const senderId = event?.sender.id ?? -1;
    if (Option.isNone(main) || main.value.isDestroyed() || main.value.webContents.id !== senderId)
      return yield* new DesktopWindowMaterial.WindowMaterialSenderError({ senderId });
    return yield* material.getState(senderId);
  }),
});
