import * as Effect from "effect/Effect";
import * as ManagedRelay from "./managedRelay.ts";

export function makeManagedRelayTestClient(
  input: Omit<
    ManagedRelay.ManagedRelayClient["Service"],
    "requestKeyReadmission" | "resetTokenCache"
  > &
    Partial<Pick<ManagedRelay.ManagedRelayClient["Service"], "resetTokenCache">>,
) {
  return ManagedRelay.ManagedRelayClient.of({
    resetTokenCache: Effect.void,
    ...input,
    requestKeyReadmission: Effect.fn("ManagedRelayTestClient.requestKeyReadmission")(
      function* () {},
    ),
  });
}
