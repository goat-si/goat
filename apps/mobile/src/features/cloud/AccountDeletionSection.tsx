import { useClerk, useReverification, useSession, useUser } from "@clerk/expo";
import {
  AccountIdentityDeletionPendingError,
  advanceAccountDeletion,
  accountDeletionMessage,
  ManagedRelay,
  type AccountDeletionResult,
} from "@goat/client-runtime/relay";
import * as Effect from "effect/Effect";
import * as Crypto from "expo-crypto";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { runtime } from "../../lib/runtime";
import * as Dialog from "../../components/ui/Dialog";

export function AccountDeletionSection() {
  const { user } = useUser();
  const { session } = useSession();
  // Resource replacement invalidates consent even when Clerk keeps the same IDs.
  const [identity, setIdentity] = useState({ user, session, version: 0 });
  if (identity.user !== user || identity.session !== session) {
    setIdentity({ user, session, version: identity.version + 1 });
  }
  return user && session ? <AccountDeletionForSession key={identity.version} /> : null;
}

function AccountDeletionForSession() {
  const clerk = useClerk();
  const user = clerk.user;
  const session = clerk.session;
  const active = useRef(true);
  // oxlint-disable-next-line goat/react-effect-budget -- Invalidate pending deletion and consent when this session leaves.
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const isCurrent = () => active.current && clerk.user === user && clerk.session === session;
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AccountDeletionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = useRef<{ accountId: string; key: string } | null>(null);
  const deleteIdentity = useReverification(
    async (user: NonNullable<typeof clerk.user>, session: NonNullable<typeof clerk.session>) => {
      if (!isCurrent() || clerk.user !== user || clerk.session !== session)
        throw new Error("Account changed. Resume with the original account.");
      return await user.delete();
    },
  );
  const advance = async (confirmed: boolean) => {
    if (!user || !session || busy || !isCurrent()) return;
    if (key.current?.accountId !== user.id)
      key.current = { accountId: user.id, key: Crypto.randomUUID() };
    setBusy(true);
    setError(null);
    try {
      const next = await advanceAccountDeletion(
        {
          accountId: user.id,
          session,
          isCurrent,
          getToken: () => session.getToken({ skipCache: true }),
          getStatus: (clerkToken) =>
            runtime.runPromise(
              ManagedRelay.ManagedRelayClient.pipe(
                Effect.flatMap((relay) => relay.getAccountDeletion({ clerkToken })),
              ),
            ),
          requestDelete: (clerkToken, idempotencyKey) =>
            runtime.runPromise(
              ManagedRelay.ManagedRelayClient.pipe(
                Effect.flatMap((relay) => relay.deleteAccount({ clerkToken, idempotencyKey })),
              ),
            ),
          deleteIdentity: () => deleteIdentity(user, session),
        },
        key.current.key,
        confirmed,
      );
      if (isCurrent()) setResult(next);
    } catch (cause) {
      if (!isCurrent()) return;
      if (cause instanceof AccountIdentityDeletionPendingError)
        setResult({ relay: cause.relay, identityDeleted: false });
      setError(
        cause instanceof Error
          ? cause.message
          : "Deletion is unconfirmed. Refresh status before retrying.",
      );
    }
    if (isCurrent()) setBusy(false);
  };
  const confirm = () => {
    if (!user || !session || !isCurrent()) return;
    Dialog.confirm({
      title: "Delete GOAT Connect account?",
      message:
        "This permanently deletes your relay data and sign-in account. Local projects stay on your machines. Machines with unconfirmed cleanup can keep existing local sessions. New requests require MFA verified within 10 minutes. Sign in again with MFA if verification is stale, then reopen this page to resume.",
      confirmText: "Delete account",
      destructive: true,
      onConfirm: () => void advance(true),
    });
  };
  return (
    <View className="gap-3 px-5 py-6">
      <Text className="text-base font-semibold text-clerk-primary">
        Delete GOAT Connect account
      </Text>
      <Text className="text-sm text-clerk-secondary">
        Permanently remove relay links, push registrations and held webhooks, then delete your
        sign-in account. Local projects and independent connections remain.
      </Text>
      {result ? (
        <Text accessibilityRole="text" className="text-sm text-clerk-primary">
          {accountDeletionMessage(result)}
        </Text>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" className="text-sm text-red-600">
          {error}
        </Text>
      ) : null}
      {!result?.identityDeleted ? (
        <>
          <Pressable accessibilityRole="button" disabled={busy} onPress={confirm}>
            <Text className="text-sm text-red-600">
              {busy ? "Working…" : "Delete account / continue"}
            </Text>
          </Pressable>
          <Pressable accessibilityRole="button" disabled={busy} onPress={() => void advance(false)}>
            <Text className="text-sm text-clerk-primary">Refresh deletion status</Text>
          </Pressable>
        </>
      ) : null}
    </View>
  );
}
