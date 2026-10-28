import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { RELAY_LINK_PROOF_TYP } from "@goat/shared/relayJwt";
import * as RelayConfiguration from "../Config.ts";
import * as DpopProofs from "../auth/DpopProofs.ts";
import * as RelayTokens from "../auth/RelayTokens.ts";
import {
  allowAccount,
  postgresFixture,
  postgresPolicyFixture,
} from "../auth/connectPostgres.testkit.ts";
import * as Reservations from "./ConnectLinkReservations.ts";
import * as Linker from "./EnvironmentLinker.ts";
import * as Provider from "./ManagedEndpointProvider.ts";
import {
  config,
  makeRequest,
  signTestJwt,
  environmentKeyPair,
  intent,
  makeAssurance,
} from "./EnvironmentLinker.testkit.ts";

export function layer(calls: string[], failProvision = false, expireDuringProvision = false) {
  return Linker.layer.pipe(
    Layer.provideMerge(Reservations.layer),
    Layer.provideMerge(Layer.mergeAll(RelayTokens.layer, DpopProofs.layer)),
    Layer.provideMerge(postgresPolicyFixture),
    Layer.provideMerge(postgresFixture),
    Layer.provide(RelayConfiguration.layer(config)),
    Layer.provide(NodeCrypto.layer),
    Layer.provide(
      Layer.mock(Provider.ManagedEndpointProvider, {
        provision: () =>
          Effect.gen(function* () {
            calls.push("provision");
            if (expireDuringProvision) yield* TestClock.adjust("10 minutes");
            if (failProvision)
              return yield* new Provider.ManagedEndpointProvisioningFailed({
                userId: "user_123",
                environmentId: "env-link-test",
                stage: "ensure-tunnel",
                cause: "provider unavailable",
              });
            return {
              endpoint: {
                providerKind: "cloudflare_tunnel" as const,
                httpBaseUrl: "https://managed.example.test",
                wsBaseUrl: "wss://managed.example.test",
              },
              runtime: { providerKind: "cloudflare_tunnel" as const, connectorToken: "connector" },
            };
          }),
        prepareDeprovision: () => Effect.succeed(null),
        deprovision: () =>
          Effect.sync(() => {
            calls.push("deprovision");
            return true;
          }),
      }),
    ),
  );
}
export const setup = Effect.gen(function* () {
  yield* TestClock.setTime(1800000000000);
  yield* allowAccount("user_123");
  const fixture = yield* makeRequest;
  const challenge = yield* (yield* RelayTokens.RelayTokens).issueLinkChallenge({
    userId: "user_123",
    request: {
      notificationsEnabled: false,
      liveActivitiesEnabled: false,
      managedTunnelsEnabled: true,
    },
    assurance: makeAssurance(1800000000),
    intent: { ...intent, managedTunnelsEnabled: true },
    jti: "challenge-jti",
    issuedAtEpochSeconds: 1800000000,
    expiresAtEpochSeconds: 1800000300,
  });
  const payload = { ...fixture.payload, challenge };
  return {
    payload,
    request: {
      ...fixture.request,
      managedTunnelsEnabled: true,
      proof: signTestJwt(payload, RELAY_LINK_PROOF_TYP, environmentKeyPair.privateKey),
    },
  };
});
