import {
  CUA_DRIVER_VERIFY_TOOLS,
  cuaDriverCapabilityManifest,
  cuaDriverManifestApplications,
  missingCuaDriverApplications,
  prepareCuaDriverCapabilityManifest,
  writeCuaDriverCapabilityManifest,
} from "@goat/shared/cuaDriverManifest";
import { cuaDriverListingEnvironment } from "@goat/shared/cuaDriverRelease";
import * as Effect from "effect/Effect";

import type { DesktopCuaDriverDependencies } from "./DesktopCuaDriver.ts";
import { withResolvedWindowsPaths } from "./windowsHostPaths.ts";

/**
 * The manifest for one daemon start. The grant check's admits only GOAT and needs no listing;
 * the agents' lists apps through listApplications when the engine gives it one, so a helper
 * that verifies its driver is the only thing that runs it.
 */
export async function prepareDesktopManifest(
  input: Parameters<DesktopCuaDriverDependencies["prepareManifest"]>[0],
): Promise<string> {
  const { join } = await import("node:path");
  const hostBundleIds = await withResolvedWindowsPaths(input.hostBundleIds, input.platform);
  return input.scope === "verify"
    ? writeCuaDriverCapabilityManifest(
        join(input.directory, "verify-manifest.yaml"),
        cuaDriverCapabilityManifest({
          applications: hostBundleIds,
          tools: CUA_DRIVER_VERIFY_TOOLS,
        }),
      )
    : prepareCuaDriverCapabilityManifest({
        binaryPath: input.binaryPath,
        platform: input.platform,
        environment: cuaDriverListingEnvironment(process.env),
        hostBundleIds,
        path: join(input.directory, "capability-manifest.yaml"),
        ...(input.listApplications ? { listApplications: input.listApplications } : {}),
      });
}

/** The caller holds the host mutex across the file update and any required restart. */
export const refreshDesktopManifest = Effect.fn("desktop.cua.refreshManifest")(function* (input: {
  readonly apps: ReadonlyArray<string>;
  readonly path: string;
  readonly read: (path: string) => Promise<string>;
  readonly prepare: () => Promise<string>;
}) {
  if (input.apps.length === 0) return false;
  const text = yield* Effect.tryPromise(() => input.read(input.path));
  const before = yield* Effect.try(() => cuaDriverManifestApplications(text));
  const missing = missingCuaDriverApplications(input.apps, before);
  if (missing.length === 0) return false;
  const path = yield* Effect.tryPromise(input.prepare);
  const updated = yield* Effect.tryPromise(() => input.read(path));
  const after = yield* Effect.try(() => cuaDriverManifestApplications(updated));
  const stillMissing = missingCuaDriverApplications(missing, after);
  if (stillMissing.length > 0)
    yield* Effect.logInfo("Approved apps are still absent from Cua Driver manifest", {
      count: stillMissing.length,
    });
  return stillMissing.length < missing.length;
});
