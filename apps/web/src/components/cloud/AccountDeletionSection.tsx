import { useClerk, useReverification, useSession, useUser } from "@clerk/react";
import {
  AccountIdentityDeletionPendingError,
  advanceAccountDeletion,
  accountDeletionMessage,
  ManagedRelay,
  type AccountDeletionResult,
} from "@goat/client-runtime/relay";
import * as Effect from "effect/Effect";
import { useEffect, useRef, useState } from "react";
import { runtime } from "../../lib/runtime";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";

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
  const [consent, setConsent] = useState<{ user: typeof user; session: typeof session } | null>(
    null,
  );
  const confirmed = consent !== null && consent.user === user && consent.session === session;
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
  const advance = async (destroy: boolean) => {
    if (!user || !session || busy || !isCurrent()) return;
    if (key.current?.accountId !== user.id) key.current = { accountId: user.id, key: randomUUID() };
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
        destroy && confirmed,
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
  return (
    <section
      className="space-y-3 border-t border-input py-5"
      aria-label="Delete GOAT Connect account"
    >
      <h2 className="text-sm font-semibold">Delete GOAT Connect account</h2>
      <p className="text-sm text-muted-foreground">
        Permanently remove relay links, push registrations and held webhooks, then delete your
        sign-in account. Local projects, provider credentials and independent connections stay on
        your machines. This cannot be undone.
      </p>
      <p className="text-sm text-muted-foreground">
        New requests require MFA verified within 10 minutes. If verification is stale, sign out,
        sign in with MFA, and return here to resume.
      </p>
      {result ? (
        <p role="status" className="text-sm">
          {accountDeletionMessage(result)}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive-foreground">
          {error}
        </p>
      ) : null}
      {!result?.identityDeleted ? (
        <>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy}
              onChange={(event) => setConsent(event.target.checked ? { user, session } : null)}
            />
            I understand this permanently deletes my GOAT Connect account.
          </label>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="destructive-outline"
              size="sm"
              disabled={!confirmed || busy || !clerk.user}
              onClick={() => void advance(true)}
            >
              {busy ? "Working…" : "Delete account / continue"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || !clerk.user}
              onClick={() => void advance(false)}
            >
              Refresh deletion status
            </Button>
          </div>
        </>
      ) : null}
    </section>
  );
}
