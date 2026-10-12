import { ChannelGatewayError, type EnvironmentId, type GoatBotHomeClaim } from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";

/** An unset home keeps existing servers eligible until the cluster claims a home. */
export const isGoatBotHome = (
  home: GoatBotHomeClaim | null,
  environmentId: EnvironmentId,
): boolean => home === null || home.environmentId === environmentId;

export class ChannelBotHome extends Context.Service<
  ChannelBotHome,
  { readonly requireHome: Effect.Effect<void, ChannelGatewayError> }
>()("goat/channels/ChannelBotHome") {}

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* environment.getEnvironmentId;
  const requireHome = Effect.gen(function* () {
    const { goatBotHome } = yield* settings.getSettings.pipe(
      Effect.mapError(() => new ChannelGatewayError({ reason: "persistence_failed" })),
    );
    if (!isGoatBotHome(goatBotHome, environmentId) && goatBotHome !== null) {
      return yield* new ChannelGatewayError({
        reason: "not_home",
        homeEnvironmentId: goatBotHome.environmentId,
      });
    }
  });
  return ChannelBotHome.of({ requireHome });
});

export const layer = Layer.effect(ChannelBotHome, make);
