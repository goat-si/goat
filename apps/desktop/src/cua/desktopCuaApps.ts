/**
 * The desktop's answer to the server's app listing requests: the apps an approval may name, and
 * their names and icons for people. Listing goes through the helper wherever one runs the driver.
 *
 * @module desktopCuaApps
 */
import { cuaRequestableApps } from "@goat/shared/cuaDriverManifest";
import { cuaDriverListingEnvironment } from "@goat/shared/cuaDriverRelease";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as DesktopTelemetryPublisher from "../telemetry/DesktopTelemetryPublisher.ts";
import type { DesktopCuaDriverDependencies, Engine } from "./DesktopCuaNative.ts";
import { withResolvedWindowsPaths } from "./windowsHostPaths.ts";

export const makeAppsRequestHandler = (input: {
  readonly publisher: DesktopTelemetryPublisher.DesktopTelemetryPublisher["Service"];
  readonly native: DesktopCuaDriverDependencies;
  readonly platform: NodeJS.Platform;
  readonly settingsPath: string;
  readonly isClosed: () => boolean;
  readonly engine: () => Effect.Effect<Engine | string | undefined>;
  readonly enginePath: (engine: Engine) => string;
  readonly hostBundleIds: (engine: Engine) => ReadonlyArray<string>;
  readonly helperListing: (
    engine: Engine,
  ) => (() => ReturnType<DesktopCuaDriverDependencies["helperApps"]>) | undefined;
}) => {
  const { publisher, native, platform } = input;
  const enabled = Effect.tryPromise(() => native.computerUseEnabled(input.settingsPath));
  return Effect.fn("desktop.cua.appsRequest")(function* () {
    const batch = yield* publisher.takeCuaAppsRequests;
    if (batch.requestIds.length === 0) return;
    const apps = yield* Effect.gen(function* () {
      if (input.isClosed() || !(yield* enabled)) return undefined;
      const selected = yield* input.engine();
      if (typeof selected !== "object") return undefined;
      const listed = yield* Effect.tryPromise(
        () =>
          input.helperListing(selected)?.() ??
          native.listApps({
            binaryPath: input.enginePath(selected),
            platform,
            environment: cuaDriverListingEnvironment(process.env),
          }),
      );
      const hosts = yield* Effect.tryPromise(() =>
        withResolvedWindowsPaths(input.hostBundleIds(selected), platform),
      );
      if (input.isClosed() || !(yield* enabled)) return undefined;
      const apps = cuaRequestableApps(listed, hosts);
      // A partial list could wrongly reject a real app, so an oversized answer is unavailable.
      if (apps.length > 1000) return undefined;
      // Names and icons are for people; a catalog that fails leaves the approval list intact.
      const catalog = yield* Effect.tryPromise(() =>
        native.appCatalog(listed, hosts, platform),
      ).pipe(Effect.option);
      return { apps, catalog: Option.getOrUndefined(catalog) };
    }).pipe(Effect.orElseSucceed(() => undefined));
    if (!input.isClosed())
      for (const requestId of batch.requestIds)
        yield* batch.publish({
          version: 1,
          type: "cuaApps",
          requestId,
          ...(apps === undefined
            ? { status: "unavailable" as const }
            : {
                status: "listed" as const,
                apps: apps.apps,
                ...(apps.catalog === undefined ? {} : { catalog: apps.catalog }),
              }),
        });
  });
};
