import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type * as Electron from "electron";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";
import type { BackendStartupFailure } from "../backend/DesktopBackendManager.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopObservability from "./DesktopObservability.ts";
import * as DesktopState from "./DesktopState.ts";

import { CLI_RELEASE_REPOSITORY, isPublishableCliReleaseVersion } from "@goat/shared/cliRelease";
import { getInitialWindowBackgroundColor } from "../window/DesktopWindowAppearance.ts";
import {
  buildStartupRecoveryHtml,
  resolveStartupRecoveryOffer,
  STARTUP_RECOVERY_ACTIONS,
  ACTION_ORIGIN,
  type StartupRecoveryAction,
} from "./DesktopStartupRecoveryView.ts";

const RELEASES_URL = `https://github.com/${CLI_RELEASE_REPOSITORY}/releases`;
const { logInfo, logWarning } = DesktopObservability.makeComponentLogger(
  "desktop-startup-recovery",
);
const LAST_STARTED_VERSION_FILE = "desktop-last-started-version";
export const listen: Effect.Effect<
  void,
  never,
  | DesktopState.DesktopState
  | DesktopUpdates.DesktopUpdates
  | DesktopEnvironment.DesktopEnvironment
  | ElectronApp.ElectronApp
  | ElectronShell.ElectronShell
  | ElectronTheme.ElectronTheme
  | ElectronWindow.ElectronWindow
  | FileSystem.FileSystem
  | Scope.Scope
> = Effect.gen(function* () {
  const { primaryBackendStartup, quitting } = yield* DesktopState.DesktopState;
  const updates = yield* DesktopUpdates.DesktopUpdates;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronApp = yield* ElectronApp.ElectronApp;
  const electronShell = yield* ElectronShell.ElectronShell;
  const electronTheme = yield* ElectronTheme.ElectronTheme;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const fileSystem = yield* FileSystem.FileSystem;
  const runFork = Effect.runForkWith(yield* Effect.context<never>());

  const lastStartedVersionPath = environment.path.join(
    environment.stateDir,
    LAST_STARTED_VERSION_FILE,
  );
  const lastStartedVersion = yield* fileSystem.readFileString(lastStartedVersionPath).pipe(
    Effect.map((text) => (isPublishableCliReleaseVersion(text.trim()) ? text.trim() : null)),
    Effect.orElseSucceed(() => null),
  );

  const windowRef = yield* Ref.make(Option.none<Electron.BrowserWindow>());
  const failureRef = yield* Ref.make(Option.none<BackendStartupFailure>());
  const renderedHtmlRef = yield* Ref.make("");
  const checkedRef = yield* Ref.make(false);
  const { latest, changes: updateChanges } = yield* updates.subscribe;
  const updateStateRef = yield* Ref.make(latest);

  const offer = Ref.get(updateStateRef).pipe(
    Effect.map((state) => resolveStartupRecoveryOffer(state, lastStartedVersion)),
  );

  const render = Effect.fn("desktop.startupRecovery.render")(function* () {
    const window = yield* Ref.get(windowRef);
    const failure = yield* Ref.get(failureRef);
    if (Option.isNone(window) || Option.isNone(failure) || window.value.isDestroyed()) return;
    const html = buildStartupRecoveryHtml({
      appVersion: environment.appVersion,
      failure: failure.value,
      offer: yield* offer,
      logDir: environment.logDir,
      updateMessage: (yield* Ref.get(updateStateRef)).message,
    });
    if ((yield* Ref.getAndSet(renderedHtmlRef, html)) === html) return;
    yield* Effect.tryPromise(() =>
      window.value.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`),
    ).pipe(
      Effect.catch((error) =>
        logWarning("could not render startup recovery", { error: String(error) }),
      ),
    );
  });

  const runAction = Effect.fn("desktop.startupRecovery.runAction")(function* (
    action: StartupRecoveryAction,
  ) {
    yield* logInfo("startup recovery action", { action });
    const current = yield* offer;
    switch (action) {
      case "update": {
        if (current._tag !== "Update") return;
        const state = yield* updates.getState;
        if (state.downloadedVersion === null) {
          const download = yield* updates.download;
          if (!download.completed) return;
        }
        yield* updates.installPrepared(current.version, { waitForCheck: true });
        return;
      }
      case "reinstall":
        if (current._tag === "Reinstall") {
          yield* electronShell.openExternal(`${RELEASES_URL}/tag/v${current.version}`);
        }
        return;
      case "releases":
        yield* electronShell.openExternal(RELEASES_URL);
        return;
      case "copy": {
        const failure = yield* Ref.get(failureRef);
        if (Option.isNone(failure)) return;
        yield* electronShell.copyText(
          `GOAT ${environment.appVersion} (${environment.platform} ${environment.processArch}) could not start.\n${failure.value.reason}\n\n${failure.value.output}`,
        );
        return;
      }
      case "quit":
        yield* electronApp.quit;
        return;
    }
  });

  const show = Effect.fn("desktop.startupRecovery.show")(
    function* () {
      if (yield* Ref.get(quitting)) return;
      if (Option.isSome(yield* electronWindow.main)) return;
      const existing = yield* Ref.get(windowRef);
      if (Option.isSome(existing) && !existing.value.isDestroyed()) {
        yield* electronWindow.reveal(existing.value);
        return;
      }
      const shouldUseDarkColors = yield* electronTheme.shouldUseDarkColors;
      const window = yield* electronWindow.create(
        {
          width: 640,
          height: 480,
          minWidth: 420,
          minHeight: 320,
          show: false,
          title: "GOAT could not start",
          autoHideMenuBar: true,
          backgroundColor: getInitialWindowBackgroundColor(shouldUseDarkColors),
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            javascript: false,
          },
        },
        { auxiliary: true },
      );
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (event, url) => {
        event.preventDefault();
        const action = STARTUP_RECOVERY_ACTIONS.find((name) => url === `${ACTION_ORIGIN}/${name}`);
        if (action !== undefined)
          runFork(
            runAction(action).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("startup recovery action failed", cause),
              ),
            ),
          );
      });
      window.once("ready-to-show", () => {
        if (!window.isDestroyed()) window.show();
      });
      window.once("closed", () => {
        runFork(
          Ref.set(windowRef, Option.none()).pipe(Effect.andThen(Ref.set(renderedHtmlRef, ""))),
        );
      });
      yield* Ref.set(windowRef, Option.some(window));
      yield* render();
      yield* logInfo("startup recovery window shown");
    },
    Effect.catch((error) =>
      logWarning("could not show startup recovery", { errorTag: error._tag }),
    ),
  );

  const close = Effect.gen(function* () {
    const window = yield* Ref.getAndSet(windowRef, Option.none());
    if (Option.isSome(window) && !window.value.isDestroyed()) window.value.close();
  });

  const rememberStartedVersion = Effect.gen(function* () {
    if (
      lastStartedVersion === environment.appVersion ||
      !isPublishableCliReleaseVersion(environment.appVersion)
    )
      return;
    yield* fileSystem.writeFileString(lastStartedVersionPath, environment.appVersion);
  }).pipe(
    Effect.catch((error) =>
      logWarning("could not record the started version", { errorTag: error._tag }),
    ),
  );

  yield* updateChanges.pipe(
    Stream.runForEach((state) => Ref.set(updateStateRef, state).pipe(Effect.andThen(render()))),
    Effect.forkScoped,
  );

  yield* SubscriptionRef.changes(primaryBackendStartup).pipe(
    Stream.runForEach(
      Effect.fn("desktop.startupRecovery.onStartupChange")(function* (startup) {
        if (startup._tag === "Ready") {
          yield* Ref.set(failureRef, Option.none());
          yield* close;
          yield* rememberStartedVersion;
          return;
        }
        if (startup._tag !== "Failing") return;
        if (Option.isSome(yield* Ref.get(failureRef))) return;
        yield* Ref.set(failureRef, Option.some({ reason: startup.reason, output: startup.output }));
        yield* logWarning("primary backend failing to start");
        yield* show();
        if (!(yield* Ref.getAndSet(checkedRef, true))) {
          yield* updates.check("startup-recovery").pipe(Effect.forkScoped);
        }
      }),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("startup recovery stopped", cause).pipe(
        Effect.annotateLogs({ component: "desktop-startup-recovery" }),
      ),
    ),
    Effect.forkScoped,
  );

  yield* electronApp.on("activate", () => {
    runFork(
      Ref.get(failureRef).pipe(
        Effect.flatMap((failure) => (Option.isSome(failure) ? show() : Effect.void)),
      ),
    );
  });
});
