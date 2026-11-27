import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import { resolveNotAppliedInstallVersion } from "./updateMachine.ts";

const { logWarning: logUpdaterWarning } =
  DesktopObservability.makeComponentLogger("desktop-updater");

export const DESKTOP_UPDATE_INSTALL_RECORD_FILE = "desktop-update-install.json";
const InstallRecord = Schema.Struct({
  fromVersion: Schema.String,
  targetVersion: Schema.String,
  phase: Schema.optionalKey(Schema.Literal("awaiting-workspace")),
});
const DesktopUpdateInstallRecord = Schema.fromJsonString(InstallRecord);
const decodeInstallRecord = Schema.decodeUnknownEffect(DesktopUpdateInstallRecord);
const encodeInstallRecord = Schema.encodeEffect(DesktopUpdateInstallRecord);

export const makeUpdateInstallRecord = Effect.fn("desktop.updates.makeInstallRecord")(function* (
  updateRestartMarkerDir: string,
) {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const installRecordPath = environment.path.join(
    updateRestartMarkerDir,
    DESKTOP_UPDATE_INSTALL_RECORD_FILE,
  );
  const staged = `${installRecordPath}.${process.pid}.next`;
  const mutex = yield* Semaphore.make(1);
  const write = (record: typeof InstallRecord.Type) =>
    encodeInstallRecord(record).pipe(
      Effect.flatMap((text) => fileSystem.writeFileString(staged, text)),
      Effect.andThen(fileSystem.rename(staged, installRecordPath)),
      Effect.ensuring(fileSystem.remove(staged, { force: true }).pipe(Effect.ignore)),
      Effect.catch((error) =>
        logUpdaterWarning("Could not record the update install.", { errorTag: error._tag }),
      ),
    );
  const remove = fileSystem.remove(installRecordPath, { force: true }).pipe(Effect.ignore);
  const read = fileSystem.readFileString(installRecordPath).pipe(
    Effect.flatMap((text) => decodeInstallRecord(text).pipe(Effect.tapError(() => remove))),
    Effect.option,
  );
  const writeInstallRecord = (targetVersion: string) =>
    mutex.withPermits(1)(write({ fromVersion: environment.appVersion, targetVersion }));
  const readNotAppliedInstallVersion = mutex.withPermits(1)(
    Effect.gen(function* () {
      const record = yield* read;
      if (Option.isNone(record)) return Option.none<string>();
      if (record.value.targetVersion === environment.appVersion) {
        if (!record.value.phase) yield* write({ ...record.value, phase: "awaiting-workspace" });
        return Option.none<string>();
      }
      const notApplied = resolveNotAppliedInstallVersion(record.value, environment.appVersion);
      // Another build can share an explicitly configured GOAT_HOME. Its unconfirmed
      // workspace record still explains an interrupted startup of that build.
      if (notApplied === null && !record.value.phase) yield* remove;
      if (notApplied !== null)
        yield* logUpdaterWarning("the last update install did not apply", {
          version: environment.appVersion,
          targetVersion: notApplied,
        });
      return Option.fromNullishOr(notApplied);
    }),
  );
  // A renderer remount can report ready after another installation has started.
  const confirmWorkspaceReady = mutex.withPermits(1)(
    Effect.gen(function* () {
      const record = yield* read;
      if (Option.isSome(record) && record.value.targetVersion === environment.appVersion)
        yield* remove;
    }),
  );
  return {
    writeInstallRecord,
    removeInstallRecord: mutex.withPermits(1)(remove),
    readNotAppliedInstallVersion,
    confirmWorkspaceReady,
  };
});
