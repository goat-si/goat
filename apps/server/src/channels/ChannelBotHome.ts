// @effect-diagnostics-next-line nodeBuiltinImport:off -- claim ids only need a random UUID.
import * as NodeCrypto from "node:crypto";

import {
  ChannelGatewayError,
  compareGoatBotHomeClaims,
  newGoatBotHomeClaim,
  type ChannelBotHomeClaimResult,
  type ChannelBotHomeStatus,
  type EnvironmentId,
  type GoatBotHomeClaim,
  type ServerSettingsError,
} from "@goat/contracts";
import * as Clock from "effect/Clock";
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
  {
    readonly requireHome: Effect.Effect<void, ChannelGatewayError>;
    readonly read: Effect.Effect<ChannelBotHomeStatus, ChannelGatewayError>;
    /**
     * Claims the home for this server with a claim newer than the one it holds. Other servers
     * adopt it when a client connected to them syncs it. `authorizeAtCommit` runs inside the
     * settings write lock, so a caller whose grant is revoked meanwhile changes nothing.
     */
    readonly claimHere: (
      authorizeAtCommit: Effect.Effect<void, ServerSettingsError>,
    ) => Effect.Effect<ChannelBotHomeClaimResult, ServerSettingsError>;
  }
>()("goat/channels/ChannelBotHome") {}

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* environment.getEnvironmentId;
  const read = settings.getSettings.pipe(
    Effect.mapError(() => new ChannelGatewayError({ reason: "persistence_failed" })),
    Effect.map(({ goatBotHome }): ChannelBotHomeStatus => ({
      home: goatBotHome,
      environmentId,
      isHome: isGoatBotHome(goatBotHome, environmentId),
    })),
  );
  const requireHome = read.pipe(
    Effect.flatMap(({ home, isHome }) =>
      isHome || home === null
        ? Effect.void
        : Effect.fail(
            new ChannelGatewayError({ reason: "not_home", homeEnvironmentId: home.environmentId }),
          ),
    ),
  );
  const claimHere = (authorizeAtCommit: Effect.Effect<void, ServerSettingsError>) =>
    Effect.gen(function* () {
      const { goatBotHome } = yield* settings.getSettings;
      const claim = newGoatBotHomeClaim({
        environmentId,
        now: yield* Clock.currentTimeMillis,
        observedMax: goatBotHome,
        randomId: () => NodeCrypto.randomUUID(),
      });
      // A newer claim written meanwhile wins; the stored settings report it.
      const stored = (yield* settings.updateSettings({ goatBotHome: claim }, authorizeAtCommit))
        .goatBotHome;
      const home = stored ?? claim;
      return {
        claimed:
          compareGoatBotHomeClaims(home, claim) === 0 && home.environmentId === environmentId,
        home,
        environmentId,
      };
    });
  return ChannelBotHome.of({ requireHome, read, claimHere });
});

export const layer = Layer.effect(ChannelBotHome, make);
