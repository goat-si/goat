import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as Electron from "electron";

import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import {
  ORIGIN_STORAGE_EXPORT_SCRIPT,
  originStorageImportScript,
} from "./rendererOriginStorage.ts";

/**
 * Copies the renderer's localStorage and IndexedDB from the legacy `t3code://app` origin to
 * `goat://app` (D13). Runs once, before the first window: a detached page on each origin exports
 * and then imports, never replacing data the new origin already holds. The legacy origin is only
 * read, so a build that still serves `t3code://app` finds its data unchanged. A failure leaves
 * no marker and retries on the next launch.
 */
export class DesktopRendererOriginMigration extends Context.Service<
  DesktopRendererOriginMigration,
  {
    readonly run: (userDataPath: string) => Effect.Effect<void>;
  }
>()("@goat/desktop/app/DesktopRendererOriginMigration") {}

export const MARKER_FILE_NAME = "renderer-origin-migrated";
const PAGE_TIMEOUT = Duration.seconds(30);

export class RendererOriginMigrationError extends Schema.TaggedError<RendererOriginMigrationError>()(
  "RendererOriginMigrationError",
  {
    step: Schema.Literals(["export", "import"]),
    url: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Could not ${this.step} renderer storage at ${this.url}.`;
  }
}

/** Runs one script on a page of the given origin and returns its string result. */
export type OriginPageRunner = (
  step: RendererOriginMigrationError["step"],
  url: string,
  script: string,
) => Effect.Effect<string, RendererOriginMigrationError>;

/**
 * The migration itself, separated from Electron for tests. Returns false when the marker shows it
 * already ran.
 */
export const migrateRendererOrigin = Effect.fn("desktop.rendererOriginMigration.migrate")(
  function* (input: {
    readonly markerPath: string;
    readonly legacyOrigin: string;
    readonly origin: string;
    readonly runPage: OriginPageRunner;
  }) {
    const fs = yield* FileSystem.FileSystem;
    if (yield* fs.exists(input.markerPath).pipe(Effect.orElseSucceed(() => false))) return false;
    const exportUrl = `${input.legacyOrigin}${ElectronProtocol.ORIGIN_MIGRATION_PATH}`;
    const importUrl = `${input.origin}${ElectronProtocol.ORIGIN_MIGRATION_PATH}`;
    const payload = yield* input.runPage("export", exportUrl, ORIGIN_STORAGE_EXPORT_SCRIPT);
    const summary = yield* input.runPage("import", importUrl, originStorageImportScript(payload));
    yield* Effect.logInfo("Copied renderer storage to the GOAT origin", {
      from: input.legacyOrigin,
      to: input.origin,
      summary,
    });
    yield* fs.writeFileString(input.markerPath, `${input.legacyOrigin} -> ${input.origin}\n`);
    return true;
  },
);

/**
 * A detached WebContentsView, so no BrowserWindow opens or closes (closing the only window quits
 * the app on Windows and Linux). It shares the main window's default session.
 */
const runDetachedPage: OriginPageRunner = (step, url, script) =>
  Effect.acquireUseRelease(
    Effect.sync(
      () =>
        new Electron.WebContentsView({
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
        }),
    ),
    (view) =>
      Effect.tryPromise({
        try: async () => {
          await view.webContents.loadURL(url);
          const result: unknown = await view.webContents.executeJavaScript(script, true);
          if (typeof result !== "string") throw new Error("The page script returned no result.");
          return result;
        },
        catch: (cause) => new RendererOriginMigrationError({ step, url, cause }),
      }).pipe(
        Effect.timeoutOrElse({
          duration: PAGE_TIMEOUT,
          orElse: () =>
            Effect.fail(
              new RendererOriginMigrationError({ step, url, cause: new Error("Timed out.") }),
            ),
        }),
      ),
    (view) => Effect.sync(() => view.webContents.close()),
  );

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const protocol = yield* ElectronProtocol.ElectronProtocol;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const run = Effect.fn("desktop.rendererOriginMigration.run")(function* (userDataPath: string) {
    const markerPath = path.join(userDataPath, MARKER_FILE_NAME);
    if (yield* fs.exists(markerPath).pipe(Effect.orElseSucceed(() => false))) return;
    yield* Effect.scoped(
      Effect.gen(function* () {
        // The legacy scheme answers only for the duration of the migration.
        yield* protocol.registerLegacyDesktopProtocol(
          ElectronProtocol.getLegacyDesktopScheme(environment.isDevelopment),
        );
        yield* migrateRendererOrigin({
          markerPath,
          legacyOrigin: ElectronProtocol.getLegacyDesktopOrigin(environment.isDevelopment),
          origin: ElectronProtocol.getDesktopOrigin(environment.isDevelopment),
          runPage: runDetachedPage,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          // Once the window opens the app creates its own data, which a later import never
          // replaces, so a transient failure gets one more try now.
          Effect.retry({ times: 1 }),
        );
      }),
    ).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not copy renderer storage; will retry next launch", error),
      ),
    );
  });

  return DesktopRendererOriginMigration.of({ run });
});

export const layer = Layer.effect(DesktopRendererOriginMigration, make);
