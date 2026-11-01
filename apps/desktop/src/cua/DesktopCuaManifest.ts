import {
  CUA_DRIVER_VERIFY_TOOLS,
  cuaDriverCapabilityManifest,
  cuaDriverManifestApplications,
  missingCuaDriverApplications,
  prepareCuaDriverCapabilityManifest,
  writeCuaDriverCapabilityManifest,
  publishCuaDriverBrowserManifest,
} from "@goat/shared/cuaDriverManifest";
import { cuaDriverListingEnvironment } from "@goat/shared/cuaDriverRelease";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

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

export const makeBrowserManifestRequestHandler = (input: {
  readonly path: () => string | undefined;
  readonly publish: (
    path: string,
    union: import("@goat/shared/cuaDriverManifest").CuaBrowserResources,
  ) => Effect.Effect<string, Error>;
}) =>
  Effect.fn("desktop.cua.publishBrowserManifest")(function* (message: {
    readonly request: {
      readonly requestId: string;
      readonly union: import("@goat/shared/cuaDriverManifest").CuaBrowserResources;
    };
    readonly reply: (value: {
      readonly requestId: string;
      readonly sha256?: string;
    }) => Effect.Effect<void>;
  }) {
    const path = input.path();
    if (!path) return yield* message.reply({ requestId: message.request.requestId });
    const result = yield* input.publish(path, message.request.union).pipe(Effect.option);
    yield* message.reply({
      requestId: message.request.requestId,
      ...(result._tag === "Some" ? { sha256: result.value } : {}),
    });
  });

class BrowserManifestPublishError extends Schema.TaggedError<BrowserManifestPublishError>()(
  "BrowserManifestPublishError",
  { cause: Schema.Defect() },
) {}

export const listenBrowserManifestRequests = (
  requests:
    | NonNullable<
        import("../telemetry/DesktopTelemetryPublisher.ts").DesktopTelemetryPublisher["Service"]["cuaManifestRequests"]
      >
    | undefined,
  path: () => string | undefined,
  mutex: import("effect/Semaphore").Semaphore,
) =>
  Stream.runForEach(requests ?? Stream.empty, (message) =>
    mutex.withPermits(1)(
      Effect.suspend(() =>
        !message.isCurrent()
          ? Effect.void
          : makeBrowserManifestRequestHandler({
              path,
              publish: (name, union) =>
                Effect.tryPromise({
                  try: () => publishCuaDriverBrowserManifest(name, union),
                  catch: (cause) => new BrowserManifestPublishError({ cause }),
                }).pipe(
                  Effect.tapError((cause) =>
                    Effect.logWarning("Could not publish browser manifest", { cause }),
                  ),
                ),
            })({
              request: message.request,
              reply: ({ requestId, sha256 }) =>
                message.reply(
                  sha256 === undefined
                    ? { version: 1, type: "cuaManifestReport", requestId, status: "unavailable" }
                    : {
                        version: 1,
                        type: "cuaManifestReport",
                        requestId,
                        status: "written",
                        sha256,
                      },
                ),
            }),
      ),
    ),
  ).pipe(Effect.forkScoped);
