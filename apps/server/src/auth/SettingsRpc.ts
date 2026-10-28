import {
  ServerSettingsError,
  type AgentTerminalBinding,
  type ProviderInstanceMutation,
  type ServerSettingsPatch,
} from "@goat/contracts";
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
    readonly agentTerminalBinding?: AgentTerminalBinding;
  }) {
    if (input.providerInstanceMutation !== undefined && input.agentTerminalBinding !== undefined)
      return yield* new ServerSettingsError({ settingsPath: "settings", operation: "normalize" });
    const updatePolicy = settings.updateAgentWorkspaceTerminalPolicy;
    const usesAgentPolicy =
      input.agentTerminalBinding !== undefined ||
      input.patch.agentWorkspaceAccess !== undefined ||
      input.patch.agentTerminalAccess !== undefined ||
      input.patch.projectSettingsOverrides !== undefined;
    return yield* input.providerInstanceMutation === undefined
      ? !usesAgentPolicy
        ? settings.updateSettings(input.patch, authorize(input.patch))
        : updatePolicy === undefined
          ? Effect.fail(
              new ServerSettingsError({ settingsPath: "settings", operation: "normalize" }),
            )
          : updatePolicy(
              input.patch,
              session.sessionId,
              input.agentTerminalBinding,
              authorize(input.patch, undefined, input.agentTerminalBinding),
            )
      : routes.mutateProviderInstance(
          { mutation: input.providerInstanceMutation, patch: input.patch },
          { kind: "client", sessionId: session.sessionId },
          undefined,
          authorize(input.patch, input.providerInstanceMutation),
        );
  });
});
