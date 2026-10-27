import { useReverification } from "@clerk/react";
import {
  invalidateManagedRelaySessionToken,
  ManagedRelay,
  runConnectSensitiveAction,
} from "@goat/client-runtime/relay";
import * as Effect from "effect/Effect";
import { runtime } from "../lib/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

function useConnectVerificationPrompt() {
  const request = useReverification(async (state: { requested: boolean }) => {
    if (!state.requested) {
      state.requested = true;
      return {
        clerk_error: {
          type: "forbidden" as const,
          reason: "reverification-error" as const,
          metadata: { reverification: { level: "multi_factor" as const, afterMinutes: 9 } },
        },
      };
    }
    return undefined;
  });
  return () => request({ requested: false });
}

async function invalidateConnectCredentials() {
  invalidateManagedRelaySessionToken(appAtomRegistry);
  await runtime.runPromise(
    ManagedRelay.ManagedRelayClient.pipe(
      Effect.flatMap((client) =>
        client.resetTokenCache.pipe(Effect.andThen(client.requestKeyReadmission)),
      ),
    ),
  );
}

export function useConnectReverification() {
  const prompt = useConnectVerificationPrompt();
  return async () => {
    await prompt();
    await invalidateConnectCredentials();
  };
}

export function useConnectSensitiveAction() {
  const prompt = useConnectVerificationPrompt();
  return <A>(action: () => Promise<A>) =>
    runConnectSensitiveAction({
      action,
      reverify: async () => {
        await prompt();
      },
      invalidate: invalidateConnectCredentials,
    });
}
