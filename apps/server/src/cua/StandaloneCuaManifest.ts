import {
  cuaDriverSessionListingEnvironment,
  listCuaRequestableApplications,
  cuaDriverManifestApplications,
  missingCuaDriverApplications,
  prepareCuaDriverCapabilityManifest,
} from "@goat/shared/cuaDriverManifest";
import { cuaDriverListingEnvironment } from "@goat/shared/cuaDriverRelease";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import type * as CuaDisplay from "./CuaDisplayCapability.ts";

/** The caller holds the host mutex across the file update and any required restart. */
export const refreshManifest = Effect.fn("CuaDriver.refreshManifestFile")(function* <E, P>(input: {
  readonly apps: ReadonlyArray<string>;
  readonly path: string;
  readonly read: (path: string) => Effect.Effect<string, E>;
  readonly prepare: Effect.Effect<string, P>;
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
  return stillMissing.length < missing.length;
});

export const make = Effect.fn("StandaloneCuaManifest.make")(function* (stateDir: string) {
  const platform = yield* HostProcess.Platform;
  const environment = yield* HostProcess.Environment;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const manifestPath = path.join(stateDir, "cua-driver", "capability-manifest.yaml");
  const prepare = Effect.fn("StandaloneCuaManifest.prepare")((binaryPath: string) =>
    Effect.tryPromise(() =>
      prepareCuaDriverCapabilityManifest({
        binaryPath,
        platform,
        environment: cuaDriverListingEnvironment(environment),
        hostBundleIds: ["si.goat.server"],
        path: manifestPath,
      }),
    ),
  );
  const refresh = Effect.fn("StandaloneCuaManifest.refresh")(function* (
    binaryPath: string,
    apps: ReadonlyArray<string>,
  ) {
    return yield* refreshManifest({
      apps,
      path: manifestPath,
      read: (path) => fs.readFileString(path),
      prepare: prepare(binaryPath),
    });
  });
  const requestListing = <E>(startBinary: Effect.Effect<string, E>) =>
    Effect.fn("StandaloneCuaManifest.requestListing")(
      (display: ReadonlyArray<CuaDisplay.CuaDisplayVariable>) =>
        startBinary.pipe(
          Effect.flatMap((binaryPath) =>
            // Interrupting the request (its deadline, or the server stopping) ends the
            // listing's driver as well.
            Effect.tryPromise((signal) =>
              listCuaRequestableApplications({
                binaryPath,
                platform,
                environment: cuaDriverSessionListingEnvironment(environment, display, platform),
                hostBundleIds: ["si.goat.server"],
                signal,
              }),
            ),
          ),
          Effect.asSome,
          Effect.orElseSucceed(() => Option.none<ReadonlyArray<string>>()),
        ),
    );

  return { prepare, refresh, requestListing };
});
