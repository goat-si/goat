import type { DesktopMicrophoneAccess } from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Electron from "electron";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { DESKTOP_HOST, getDesktopScheme } from "../electron/ElectronProtocol.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { createMediaPermissionPolicy } from "./MediaPermissionPolicy.ts";

export class MediaPermissions extends Context.Service<
  MediaPermissions,
  {
    /** Before any window loads: the main window's session decides who gets the microphone. */
    readonly installOnDefaultSession: Effect.Effect<void>;
    readonly requestMicrophoneAccess: Effect.Effect<DesktopMicrophoneAccess>;
  }
>()("@goat/desktop/permissions/MediaPermissions") {}

export const layer = Layer.effect(
  MediaPermissions,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const windows = yield* ElectronWindow.ElectronWindow;
    const runSync = Effect.runSyncWith(yield* Effect.context<never>());
    const policy = createMediaPermissionPolicy<Electron.WebContents>({
      appScheme: getDesktopScheme(environment.isDevelopment),
      appHost: DESKTOP_HOST,
      platform: environment.platform,
      isCurrentMainWebContents: (webContents) =>
        Option.match(runSync(windows.main), {
          onNone: () => false,
          onSome: (window) => window.webContents === webContents,
        }),
      readMicrophoneStatus: () => Electron.systemPreferences.getMediaAccessStatus("microphone"),
      askForMicrophone: () => Electron.systemPreferences.askForMediaAccess("microphone"),
    });
    return MediaPermissions.of({
      installOnDefaultSession: Effect.sync(() => {
        const session = Electron.session.defaultSession;
        session.setPermissionRequestHandler(policy.request);
        session.setPermissionCheckHandler(policy.check);
      }),
      requestMicrophoneAccess: Effect.promise(() => policy.requestMicrophoneAccess()).pipe(
        Effect.withSpan("MediaPermissions.requestMicrophoneAccess"),
      ),
    });
  }),
);
