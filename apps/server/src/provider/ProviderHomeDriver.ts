import { ProviderHomeRouteConfig } from "@goat/contracts";
import type { ProviderDriver } from "@goat/provider-core/server/driver";
import { ProviderDriverError } from "@goat/provider-core/server/errors";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Routes from "./CodexRouteService.ts";
import type { ProviderHomeOverlayDriver } from "./ProviderHomeAdapters.ts";
import { guardProviderHomeInstance } from "./ProviderHomeGuard.ts";
import { prepareProviderHomeRuntime, type ProviderHomeRuntimeEnv } from "./ProviderHomeRuntime.ts";

export type ProviderHomeDriverEnv = ProviderHomeRuntimeEnv | Routes.CodexRouteState;
const decodeRoute = Schema.decodeUnknownEffect(ProviderHomeRouteConfig);

/**
 * Applies an explicitly selected Home route to every runtime the driver creates: discovery,
 * sessions, resume/fork and text generation all receive the same process-only overlay. A failed
 * preparation leaves the instance unavailable; it never launches with the provider's own route.
 */
export const withProviderHomeRoute = <C, R, U>(
  kind: ProviderHomeOverlayDriver,
  driver: ProviderDriver<C, R, U>,
): ProviderDriver<C, R | ProviderHomeDriverEnv, U> => ({
  ...driver,
  create: Effect.fn("ProviderHomeDriver.create")(function* (input) {
    const unavailable = (detail: string, cause?: unknown) =>
      new ProviderDriverError({
        driver: driver.driverKind,
        instanceId: input.instanceId,
        detail,
        ...(cause === undefined ? {} : { cause }),
      });
    const leases = yield* Routes.CodexRouteState;
    const revision = yield* Routes.HydratingRevision;
    // Skip the export when this snapshot is already superseded.
    yield* leases
      .assertCurrent(input.instanceId, revision)
      .pipe(Effect.mapError((cause) => unavailable(cause.message, cause)));
    const route = yield* decodeRoute(input.config).pipe(
      Effect.mapError(() => unavailable("This instance's Home route settings are invalid.")),
    );
    const home =
      input.enabled && route.modelRoute === "opencodex"
        ? yield* prepareProviderHomeRuntime(
            kind,
            input.instanceId,
            input.config,
            input.environment,
          ).pipe(Effect.mapError((cause) => unavailable(cause.detail, cause)))
        : undefined;
    const instance = yield* driver.create(
      home === undefined ? input : { ...input, environment: home.environment },
    );
    // Bound only after the asynchronous export and construction, in the registry's instance scope.
    const generation = yield* leases
      .bindRuntime(
        input.instanceId,
        Routes.instanceFingerprint({
          driver: driver.driverKind,
          environment: input.environment,
          enabled: input.enabled,
          config: input.config,
        }),
        revision,
      )
      .pipe(Effect.mapError((cause) => unavailable(cause.message, cause)));
    return guardProviderHomeInstance(instance, home, leases, generation);
  }),
});
