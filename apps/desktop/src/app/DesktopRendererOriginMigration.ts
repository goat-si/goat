import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import * as Electron from "electron";

import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import {
  ORIGIN_STORAGE_EXPORT_NEXT_SCRIPT,
  ORIGIN_STORAGE_IMPORTER_SCRIPT,
  originStorageExporterScript,
  originStorageImportChunkScript,
  type OriginChunkLimits,
} from "./rendererOriginStorage.ts";

/**
 * Copies the renderer's localStorage and IndexedDB from the legacy `t3code://app` origin to
 * `goat://app` (D13). Runs once, before the first window: a detached page on each origin stays
 * open while main relays bounded chunks from one to the other, never replacing data the new
 * origin already holds. The legacy origin is only read, so a build that still serves
 * `t3code://app` finds its data unchanged. A failure leaves no marker and retries on the next
 * launch; an attempt that kills the process (which no catch sees) is marked aborted by the next
 * launch, so it cannot crash-loop.
 */
export class DesktopRendererOriginMigration extends Context.Service<
  DesktopRendererOriginMigration,
  {
    readonly run: (userDataPath: string) => Effect.Effect<void>;
  }
>()("@goat/desktop/app/DesktopRendererOriginMigration") {}

const MARKER_FILE_NAME = "renderer-origin-migrated";
const ATTEMPT_FILE_NAME = "renderer-origin-migration-attempt";
const STEP_TIMEOUT = Duration.seconds(30);

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

/** A loaded page on one origin that runs scripts and returns their results. */
export interface OriginPage {
  readonly run: (script: string) => Effect.Effect<unknown, RendererOriginMigrationError>;
}

export type OriginPageOpener = (
  step: RendererOriginMigrationError["step"],
  url: string,
) => Effect.Effect<OriginPage, RendererOriginMigrationError, Scope.Scope>;

const ExportSize = Schema.Struct({
  usageBytes: Schema.NullOr(Schema.Number),
  localStorageItems: Schema.Number,
  databases: Schema.Number,
  stores: Schema.Number,
  records: Schema.Number,
});

const ExportStep = Schema.Union([
  Schema.Struct({
    done: Schema.Literal(true),
    skipped: Schema.Number,
    oversized: Schema.Number,
  }),
  Schema.Struct({
    done: Schema.Literal(false),
    database: Schema.NullOr(Schema.String),
    store: Schema.NullOr(Schema.String),
    records: Schema.Number,
    bytes: Schema.Number,
    chunk: Schema.String,
  }),
]);

const ImportResult = Schema.Struct({
  localStorageItems: Schema.Number,
  records: Schema.Number,
  skipped: Schema.Number,
});

const decodeExportSize = Schema.decodeUnknownEffect(ExportSize);
const decodeExportStep = Schema.decodeUnknownEffect(ExportStep);
const decodeImportResult = Schema.decodeUnknownEffect(ImportResult);

const runDecoded = <A, E>(
  page: OriginPage,
  step: RendererOriginMigrationError["step"],
  url: string,
  script: string,
  decode: (result: unknown) => Effect.Effect<A, E>,
) =>
  page
    .run(script)
    .pipe(
      Effect.flatMap((result) =>
        decode(result).pipe(
          Effect.mapError((cause) => new RendererOriginMigrationError({ step, url, cause })),
        ),
      ),
    );

/**
 * The migration itself, separated from Electron for tests. Returns false when a marker shows it
 * already ran or an earlier attempt died.
 */
export const migrateRendererOrigin = Effect.fn("desktop.rendererOriginMigration.migrate")(
  function* (input: {
    readonly markerPath: string;
    readonly attemptPath: string;
    readonly legacyOrigin: string;
    readonly origin: string;
    readonly openPage: OriginPageOpener;
    readonly limits?: OriginChunkLimits;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const exists = (path: string) => fs.exists(path).pipe(Effect.orElseSucceed(() => false));
    if (yield* exists(input.markerPath)) return false;
    const direction = `${input.legacyOrigin} -> ${input.origin}`;
    if (yield* exists(input.attemptPath)) {
      yield* Effect.logWarning(
        "An earlier renderer storage copy did not finish; opening without it. The legacy origin still holds its data.",
        { from: input.legacyOrigin, to: input.origin },
      );
      yield* fs.writeFileString(input.markerPath, `${direction} aborted\n`);
      yield* fs.remove(input.attemptPath).pipe(Effect.ignore);
      return false;
    }
    yield* fs.writeFileString(input.attemptPath, `${direction}\n`);

    yield* copyStorage(input).pipe(
      Effect.andThen(fs.writeFileString(input.markerPath, `${direction}\n`)),
      // A failure main survives retries on the next launch; only a dead process leaves this.
      Effect.ensuring(fs.remove(input.attemptPath).pipe(Effect.ignore)),
    );
    return true;
  },
);

/**
 * Relays one chunk at a time, so main holds at most one chunk and its import script. Each chunk
 * is its own span: the trace file gets a span when it ends, so a launch that dies mid-copy still
 * shows how far it got.
 */
const copyStorage = Effect.fn("desktop.rendererOriginMigration.copy")(function* (input: {
  readonly legacyOrigin: string;
  readonly origin: string;
  readonly openPage: OriginPageOpener;
  readonly limits?: OriginChunkLimits;
}) {
  const exportUrl = `${input.legacyOrigin}${ElectronProtocol.ORIGIN_MIGRATION_PATH}`;
  const importUrl = `${input.origin}${ElectronProtocol.ORIGIN_MIGRATION_PATH}`;
  const exporter = yield* input.openPage("export", exportUrl);
  const importer = yield* input.openPage("import", importUrl);

  const size = yield* runDecoded(
    exporter,
    "export",
    exportUrl,
    originStorageExporterScript(input.limits),
    decodeExportSize,
  ).pipe(
    Effect.tap((size) => Effect.annotateCurrentSpan(size)),
    Effect.withSpan("desktop.rendererOriginMigration.size"),
  );
  yield* Effect.logInfo("Copying renderer storage to the GOAT origin", {
    from: input.legacyOrigin,
    to: input.origin,
    ...size,
  });
  yield* importer.run(ORIGIN_STORAGE_IMPORTER_SCRIPT);

  const totals = { chunks: 0, bytes: 0, records: 0, localStorageItems: 0, skipped: 0 };
  const copyChunk = Effect.gen(function* () {
    const step = yield* runDecoded(
      exporter,
      "export",
      exportUrl,
      ORIGIN_STORAGE_EXPORT_NEXT_SCRIPT,
      decodeExportStep,
    );
    if (step.done) return step;
    const result = yield* runDecoded(
      importer,
      "import",
      importUrl,
      originStorageImportChunkScript(step.chunk),
      decodeImportResult,
    );
    totals.chunks++;
    totals.bytes += step.bytes;
    totals.records += result.records;
    totals.localStorageItems += result.localStorageItems;
    totals.skipped += result.skipped;
    yield* Effect.annotateCurrentSpan({
      database: step.database ?? "",
      store: step.store ?? "",
      records: step.records,
      bytes: step.bytes,
      chunkLength: step.chunk.length,
      imported: result.records + result.localStorageItems,
      totalBytes: totals.bytes,
      totalRecords: totals.records,
    });
    return undefined;
  }).pipe(Effect.withSpan("desktop.rendererOriginMigration.chunk"));

  let done: Extract<typeof ExportStep.Type, { done: true }> | undefined;
  while (done === undefined) done = yield* copyChunk;
  yield* Effect.logInfo("Copied renderer storage to the GOAT origin", {
    from: input.legacyOrigin,
    to: input.origin,
    ...totals,
    skipped: totals.skipped + done.skipped + done.oversized,
    oversized: done.oversized,
  });
}, Effect.scoped);

const tryPage = <A>(
  step: RendererOriginMigrationError["step"],
  url: string,
  run: () => Promise<A>,
) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new RendererOriginMigrationError({ step, url, cause }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: STEP_TIMEOUT,
      orElse: () =>
        Effect.fail(
          new RendererOriginMigrationError({ step, url, cause: new Error("Timed out.") }),
        ),
    }),
  );

/**
 * A detached WebContentsView, so no BrowserWindow opens or closes (closing the only window quits
 * the app on Windows and Linux). It shares the main window's default session.
 */
const openDetachedPage: OriginPageOpener = (step, url) =>
  Effect.acquireRelease(
    Effect.sync(
      () =>
        new Electron.WebContentsView({
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
        }),
    ),
    (view) => Effect.sync(() => view.webContents.close()),
  ).pipe(
    Effect.tap((view) => tryPage(step, url, () => view.webContents.loadURL(url))),
    Effect.map((view): OriginPage => ({
      run: (script) =>
        tryPage(step, url, (): Promise<unknown> =>
          view.webContents.executeJavaScript(script, true),
        ),
    })),
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
          attemptPath: path.join(userDataPath, ATTEMPT_FILE_NAME),
          legacyOrigin: ElectronProtocol.getLegacyDesktopOrigin(environment.isDevelopment),
          origin: ElectronProtocol.getDesktopOrigin(environment.isDevelopment),
          openPage: openDetachedPage,
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
