import { makeRelayJwtSigner } from "@goat/shared/relayJwt";
import * as Effect from "effect/Effect";
import type * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { getOrCreateEnvironmentKeyPairFromSecretStore } from "./environmentKeys.ts";

export const load = Effect.fn("EnvironmentSigningKey.load")(function* (
  secrets: ServerSecretStore.ServerSecretStore["Service"],
) {
  const keyPair = yield* getOrCreateEnvironmentKeyPairFromSecretStore(secrets);
  return { publicKey: keyPair.publicKey, sign: makeRelayJwtSigner(keyPair.privateKey) };
});

export type EnvironmentSigningKey = Effect.Success<ReturnType<typeof load>>;

export function loader(secrets: ServerSecretStore.ServerSecretStore["Service"]) {
  let cached: EnvironmentSigningKey | undefined;
  return Effect.suspend(() =>
    cached === undefined
      ? load(secrets).pipe(
          Effect.tap((key) =>
            Effect.sync(() => {
              cached = key;
            }),
          ),
        )
      : Effect.succeed(cached),
  );
}
