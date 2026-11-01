import {
  cuaDriverSessionListingEnvironment,
  listCuaRequestableApplicationListing,
  cuaDriverManifestApplications,
  missingCuaDriverApplications,
  prepareCuaDriverCapabilityManifest,
  writeCuaDriverCapabilityManifest,
  publishCuaDriverBrowserManifest,
  type CuaBrowserResources,
} from "@goat/shared/cuaDriverManifest";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerSettings from "../serverSettings.ts";

class BrowserManifestWriteError extends Schema.TaggedError<BrowserManifestWriteError>()(
  "BrowserManifestWriteError",
  { cause: Schema.Defect() },
) {}
import type * as CuaDisplay from "./CuaDisplayCapability.ts";

/** The caller holds the host mutex across the file update and any required restart. */
/**
 * The file on disk always matches the running driver: a refresh that keeps the driver writes back
 * the manifest it read, so an app the re-listing found early is compared again when approved.
 */
export const refreshManifest = Effect.fn("CuaDriver.refreshManifestFile")(function* <
  E,
  P,
  W,
>(input: {
  readonly apps: ReadonlyArray<string>;
  readonly path: string;
  readonly read: (path: string) => Effect.Effect<string, E>;
  readonly prepare: Effect.Effect<string, P>;
  readonly restore: (text: string) => Effect.Effect<void, W>;
}) {
  if (input.apps.length === 0) return false;
  const text = yield* input.read(input.path);
  const before = yield* Effect.try(() => cuaDriverManifestApplications(text));
  const missing = missingCuaDriverApplications(input.apps, before);
  if (missing.length === 0) return false;
  const path = yield* input.prepare;
  const updated = yield* input.read(path);
  const after = yield* Effect.try(() => cuaDriverManifestApplications(updated));
  const stillMissing = missingCuaDriverApplications(missing, after);
  if (stillMissing.length > 0)
    yield* Effect.logInfo("Approved apps are still absent from Cua Driver manifest", {
      count: stillMissing.length,
    });
  if (stillMissing.length < missing.length) return true;
  yield* input.restore(text);
  return false;
});

export const make = Effect.fn("StandaloneCuaManifest.make")(function* (
  stateDir: string,
  hostBundleId: string,
) {
  const platform = yield* HostProcess.Platform;
  const environment = yield* HostProcess.Environment;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const manifestPath = path.join(stateDir, "cua-driver", "capability-manifest.yaml");
  const settings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
  // Without strict input guards requests may name protected apps; an unreadable choice is strict.
  const includeProtected = Option.isSome(settings)
    ? settings.value.getSettings.pipe(
        Effect.map((current) => !current.cuaStrictInputGuards),
        Effect.orElseSucceed(() => false),
      )
    : Effect.succeed(false);
  // Listed on the driver's own screen: a server started over SSH has no DISPLAY of its own, and
  // without one the listing sees no windows, so apps without a desktop entry never get admitted.
  const prepare = Effect.fn("StandaloneCuaManifest.prepare")(
    (binaryPath: string, display: ReadonlyArray<CuaDisplay.CuaDisplayVariable>) =>
      Effect.tryPromise(() =>
        prepareCuaDriverCapabilityManifest({
          binaryPath,
          platform,
          environment: cuaDriverSessionListingEnvironment(environment, display, platform),
          hostBundleIds: [hostBundleId],
          path: manifestPath,
        }),
      ),
  );
  const refresh = Effect.fn("StandaloneCuaManifest.refresh")(function* (
    binaryPath: string,
    apps: ReadonlyArray<string>,
    display: ReadonlyArray<CuaDisplay.CuaDisplayVariable>,
  ) {
    return yield* refreshManifest({
      apps,
      path: manifestPath,
      read: (path) => fs.readFileString(path),
      prepare: prepare(binaryPath, display),
      restore: (text) =>
        Effect.tryPromise(() => writeCuaDriverCapabilityManifest(manifestPath, text)),
    });
  });
  const requestListing = <E>(startBinary: Effect.Effect<string, E>) =>
    Effect.fn("StandaloneCuaManifest.requestListing")(
      (display: ReadonlyArray<CuaDisplay.CuaDisplayVariable>) =>
        Effect.all([startBinary, includeProtected]).pipe(
          Effect.flatMap(([binaryPath, protectedApps]) =>
            // Interrupting the request (its deadline, or the server stopping) ends the
            // listing's driver as well.
            Effect.tryPromise((signal) =>
              listCuaRequestableApplicationListing({
                binaryPath,
                platform,
                environment: cuaDriverSessionListingEnvironment(environment, display, platform),
                hostBundleIds: [hostBundleId],
                signal,
                includeProtected: protectedApps,
              }),
            ),
          ),
          Effect.asSome,
          Effect.orElseSucceed(() => Option.none()),
        ),
    );

  const publish = Effect.fn("StandaloneCuaManifest.publishBrowser")((union: CuaBrowserResources) =>
    Effect.tryPromise({
      try: () => publishCuaDriverBrowserManifest(manifestPath, union),
      catch: (cause) => new BrowserManifestWriteError({ cause }),
    }),
  );
  return { prepare, refresh, requestListing, publish };
});
