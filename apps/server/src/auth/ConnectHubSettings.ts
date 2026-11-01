import { ServerSettingsError, type HubSettings } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../config.ts";
import * as HubConnectAccess from "./HubConnectAccess.ts";

const isSettingsError = Schema.is(ServerSettingsError);
export const make = Effect.gen(function* () {
  const isAccessError = Schema.is(HubConnectAccess.HubConnectAccessError);
  const access = yield* HubConnectAccess.HubConnectAccess;
  const { settingsPath } = yield* ServerConfig.ServerConfig;
  const failure = (cause: unknown) =>
    isSettingsError(cause)
      ? cause
      : new ServerSettingsError({ settingsPath, operation: "write-file", cause });
  return {
    commit: Effect.fn("ConnectHubSettings.commit")(function <A, E, R>(
      hub: HubSettings,
      commit: Effect.Effect<A, E, R>,
      authorizeBeforeWithdrawal?: Effect.Effect<void, E, R>,
    ) {
      return access
        .commitPolicy(hub.enabled && hub.connectDevicesHubProxy, commit, authorizeBeforeWithdrawal)
        .pipe(Effect.mapError((cause) => (isAccessError(cause) ? failure(cause) : cause)));
    }),
    startup: Effect.fn("ConnectHubSettings.startup")(function* <A, R>(
      attempt: Effect.Effect<A, ServerSettingsError, R>,
    ): Effect.fn.Return<A, ServerSettingsError, R> {
      const reconcile: Effect.Effect<A, ServerSettingsError, R> = Effect.suspend(() =>
        access.awaitRecovery.pipe(
          Effect.andThen(attempt),
          Effect.catchTags({
            ServerSettingsError: (cause) =>
              access.current.pipe(
                Effect.flatMap((state) =>
                  isAccessError(cause.cause) && state.fenced ? reconcile : Effect.fail(cause),
                ),
              ),
          }),
        ),
      );
      return yield* reconcile;
    }),
  };
});
