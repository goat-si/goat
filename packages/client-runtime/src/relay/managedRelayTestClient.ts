import * as Effect from "effect/Effect";
import * as ManagedRelay from "./managedRelay.ts";

export function makeManagedRelayTestClient(
  input: Omit<
    ManagedRelay.ManagedRelayClient["Service"],
    "requestKeyReadmission" | "resetTokenCache" | "deleteAccount" | "getAccountDeletion"
  > &
    Partial<
      Pick<
        ManagedRelay.ManagedRelayClient["Service"],
        "resetTokenCache" | "deleteAccount" | "getAccountDeletion"
      >
    >,
) {
  return ManagedRelay.ManagedRelayClient.of({
    resetTokenCache: Effect.void,
    deleteAccount: () => Effect.die("Account deletion is outside this fixture"),
    getAccountDeletion: () => Effect.die("Account deletion is outside this fixture"),
    ...input,
    requestKeyReadmission: () => Effect.void,
  });
}
