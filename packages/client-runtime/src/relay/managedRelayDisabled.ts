import * as Effect from "effect/Effect";
import { ManagedRelayClient, ManagedRelayUrlInvalidError } from "./managedRelay.ts";

export function disabledManagedRelayClient(relayUrl: string): ManagedRelayClient["Service"] {
  const unavailable = (spanName: string) =>
    Effect.fn(spanName)(function* () {
      return yield* new ManagedRelayUrlInvalidError({ relayUrl });
    });
  return ManagedRelayClient.of({
    relayUrl,
    deleteAccount: unavailable("clientRuntime.managedRelay.deleteAccount"),
    getAccountDeletion: unavailable("clientRuntime.managedRelay.getAccountDeletion"),
    listEnvironments: unavailable("clientRuntime.managedRelay.listEnvironments"),
    listDevices: unavailable("clientRuntime.managedRelay.listDevices"),
    createEnvironmentLinkChallenge: unavailable(
      "clientRuntime.managedRelay.createEnvironmentLinkChallenge",
    ),
    linkEnvironment: unavailable("clientRuntime.managedRelay.linkEnvironment"),
    unlinkEnvironment: unavailable("clientRuntime.managedRelay.unlinkEnvironment"),
    getEnvironmentStatus: unavailable("clientRuntime.managedRelay.getEnvironmentStatus"),
    connectEnvironment: unavailable("clientRuntime.managedRelay.connectEnvironment"),
    registerDevice: unavailable("clientRuntime.managedRelay.registerDevice"),
    unregisterDevice: unavailable("clientRuntime.managedRelay.unregisterDevice"),
    registerLiveActivity: unavailable("clientRuntime.managedRelay.registerLiveActivity"),
    getAgentActivitySnapshot: unavailable("clientRuntime.managedRelay.getAgentActivitySnapshot"),
    requestKeyReadmission: unavailable("clientRuntime.managedRelay.readmitKey"),
    resetTokenCache: Effect.void.pipe(
      Effect.withSpan("clientRuntime.managedRelay.resetTokenCache"),
    ),
  });
}
