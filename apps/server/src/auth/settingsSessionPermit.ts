import * as Option from "effect/Option";
import * as HubConnectAccess from "./HubConnectAccess.ts";
import {
  ServerSettingsError,
  type ProviderInstanceMutation,
  type ServerSettingsPatch,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as RpcAuthorization from "./RpcAuthorization.ts";
import * as SessionStore from "./SessionStore.ts";
import type { AuthenticatedSession } from "./EnvironmentAuth.ts";
import { WS_METHODS } from "@goat/contracts";

export const make = Effect.fn("SettingsSessionPermit.make")(function* (
  session: AuthenticatedSession,
) {
  const sessions = yield* SessionStore.SessionStore;
  const access = yield* Effect.serviceOption(HubConnectAccess.HubConnectAccess);
  return Effect.fn("SettingsSessionPermit.authorize")(function* (
    patch: ServerSettingsPatch,
    providerInstanceMutation?: ProviderInstanceMutation,
  ) {
    if (Option.isNone(access))
      return yield* new ServerSettingsError({
        settingsPath: "hub",
        operation: "write-file",
        cause: "Hub authorization is unavailable",
      });
    const live = yield* sessions
      .readActiveScopes(session.sessionId)
      .pipe(
        Effect.mapError(
          (cause) =>
            new ServerSettingsError({ settingsPath: "hub", operation: "write-file", cause }),
        ),
      );
    const required = RpcAuthorization.requiredScopesForRpcCall(WS_METHODS.serverUpdateSettings, {
      patch,
      ...(providerInstanceMutation === undefined ? {} : { providerInstanceMutation }),
    });
    if (
      !HubConnectAccess.admits(session, yield* access.value.current) ||
      !required.every((scope) => session.scopes.includes(scope) && live.includes(scope))
    )
      return yield* new ServerSettingsError({
        settingsPath: "hub",
        operation: "write-file",
        cause: "Settings authority ended before commit",
      });
  });
});
