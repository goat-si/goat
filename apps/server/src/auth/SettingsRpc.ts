import type { ProviderInstanceMutation, ServerSettingsPatch } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as CodexRoutes from "../provider/CodexRouteService.ts";
import * as Settings from "../serverSettings.ts";
import type { AuthenticatedSession } from "./EnvironmentAuth.ts";
import * as SettingsSessionPermit from "./settingsSessionPermit.ts";

export const make = Effect.fn("SettingsRpc.make")(function* (session: AuthenticatedSession) {
  const settings = yield* Settings.ServerSettingsService;
  const routes = yield* CodexRoutes.CodexRouteService;
  const authorize = yield* SettingsSessionPermit.make(session);
  return Effect.fn("SettingsRpc.update")(function* (input: {
    readonly patch: ServerSettingsPatch;
    readonly providerInstanceMutation?: ProviderInstanceMutation;
  }) {
    return yield* input.providerInstanceMutation === undefined
      ? settings.updateSettings(input.patch, authorize(input.patch))
      : routes.mutateProviderInstance(
          { mutation: input.providerInstanceMutation, patch: input.patch },
          { kind: "client", sessionId: session.sessionId },
          undefined,
          authorize(input.patch, input.providerInstanceMutation),
        );
  });
});
