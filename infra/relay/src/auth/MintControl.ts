import { RelayApi } from "@goat/contracts/relay";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { RelayMintDisabledError } from "@goat/contracts/relayErrors";
import { RelayConfiguration } from "../Config.ts";

export const config = Config.schema(Schema.Literals(["true", "false"]), "RELAY_MINT_DISABLED").pipe(
  Config.withDefault("false"),
  Config.map((value) => value === "true"),
);
export const assertEnabled = Effect.fn("MintControl.assertEnabled")(function* (
  settings: RelayConfiguration["Service"],
) {
  if (settings.mintDisabled === true)
    return yield* new RelayMintDisabledError({ code: "relay_mint_disabled", traceId: "relay" });
});
const mintPaths = new Set<string>([
  RelayApi.groups.token.endpoints.exchangeDpopAccessToken.path,
  RelayApi.groups.client.endpoints.createEnvironmentLinkChallenge.path,
  RelayApi.groups.client.endpoints.linkEnvironment.path,
  RelayApi.groups.dpopClient.endpoints.connectEnvironment.path,
  RelayApi.groups.dpopClient.endpoints.getEnvironmentStatus.path,
  RelayApi.groups.server.endpoints.registerManagedEndpointRecovery.path,
  RelayApi.groups.server.endpoints.recoverManagedEndpoint.path,
]);
export function isMintRequest(method: string, routePath: string): boolean {
  return method === "POST" && mintPaths.has(routePath);
}
