import { RemoteEnvironmentAuthorization } from "@goat/client-runtime/authorization/service";
import { ManagedRelay } from "@goat/client-runtime/relay";
import type { EnvironmentId } from "@goat/contracts";
import type { EnvironmentVoiceRequestContext } from "@goat/client-runtime/voice-input";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { connectionAtomRuntime } from "../../connection/runtime";
import { environmentSession } from "../../state/session";
import { environmentPresentations } from "../../state/presentation";

const voiceServicesAtom = connectionAtomRuntime.atom(
  Effect.gen(function* () {
    const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
    const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
    return { signer, remoteAuthorization };
  }),
);

export const voiceRequestContextsAtom = Atom.make((get) => {
  const services = get(voiceServicesAtom);
  const presentations = get(environmentPresentations.presentationsAtom);
  const contexts = new Map<EnvironmentId, EnvironmentVoiceRequestContext>();
  if (!AsyncResult.isSuccess(services)) return contexts;
  for (const [environmentId, presentation] of presentations) {
    if (presentation.connection.phase !== "connected") continue;
    const prepared = Option.getOrNull(
      get(environmentSession.preparedConnectionValueAtom(environmentId)),
    );
    if (prepared) contexts.set(environmentId, { prepared, ...services.value });
  }
  return contexts;
});
