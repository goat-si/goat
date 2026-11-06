import { makeRelayJwtSigner, makeRelayJwtVerifier } from "@goat/shared/relayJwt";
import * as Redacted from "effect/Redacted";
import type * as RelayConfiguration from "../Config.ts";

export function make(config: RelayConfiguration.RelayConfiguration["Service"]) {
  const sign = makeRelayJwtSigner(Redacted.value(config.cloudMintPrivateKey));
  return {
    sign,
    verify: makeRelayJwtVerifier(config.cloudMintPublicKey),
  };
}
