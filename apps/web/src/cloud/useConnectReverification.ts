import { useReverification } from "@clerk/react";
import {
  invalidateManagedRelaySessionToken,
  managedRelaySessionAtom,
  readmitConnectKey,
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
    return true;
  });
  return async () => {
    const completed = await request({ requested: false });
    if (completed !== true) throw new Error("Connect verification cancelled.");
  };
}

async function invalidateConnectCredentials() {
  invalidateManagedRelaySessionToken(appAtomRegistry);
  const session = appAtomRegistry.get(managedRelaySessionAtom);
  if (!session) throw new Error("Sign in with MFA before restoring Connect access.");
  await runtime.runPromise(
    Effect.gen(function* () {
      const client = yield* ManagedRelay.ManagedRelayClient;
      yield* client.resetTokenCache;
      const clerkToken = yield* session.readClerkToken();
      if (!clerkToken) throw new Error("Sign in with MFA before restoring Connect access.");
      if (appAtomRegistry.get(managedRelaySessionAtom) !== session)
        throw new Error("Connect account changed.");
      yield* client.requestKeyReadmission({ accountId: session.accountId, clerkToken });
    }),
  );
}

export function useConnectReverification() {
  const prompt = useConnectVerificationPrompt();
  return async () => {
    const accountId = appAtomRegistry.get(managedRelaySessionAtom)?.accountId;
    if (!accountId) throw new Error("Sign in before restoring Connect access.");
    await readmitConnectKey({
      accountId,
      currentAccountId: () => appAtomRegistry.get(managedRelaySessionAtom)?.accountId ?? null,
      reverify: async () => {
        await prompt();
      },
      invalidate: async () => {
        invalidateManagedRelaySessionToken(appAtomRegistry);
      },
      readmit: invalidateConnectCredentials,
    });
  };
}

export function useConnectSensitiveAction() {
  const prompt = useConnectVerificationPrompt();
  return <A>(action: () => Promise<A>) => {
    const accountId = appAtomRegistry.get(managedRelaySessionAtom)?.accountId;
    return runConnectSensitiveAction({
      action,
      reverify: async () => {
        await prompt();
        if (!accountId || appAtomRegistry.get(managedRelaySessionAtom)?.accountId !== accountId)
          throw new Error("Connect account changed. Start the action again.");
      },
      invalidate: invalidateConnectCredentials,
    });
  };
}
