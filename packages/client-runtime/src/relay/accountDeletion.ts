import type { RelayAccountDeletion, RelayAccountDeletionStatus } from "@goat/contracts/relay";
import { decodeRelayJwt } from "@goat/shared/relayJwt";

export interface AccountDeletionAdapter {
  readonly accountId: string;
  readonly session: object;
  readonly isCurrent: () => boolean;
  readonly getToken: () => Promise<string | null>;
  readonly getStatus: (token: string) => Promise<RelayAccountDeletionStatus>;
  readonly requestDelete: (token: string, key: string) => Promise<RelayAccountDeletion>;
  readonly deleteIdentity: () => Promise<unknown>;
}
export interface AccountDeletionResult {
  readonly relay: RelayAccountDeletionStatus;
  readonly identityDeleted: boolean;
}
export class AccountIdentityDeletionPendingError extends Error {
  constructor(
    readonly relay: RelayAccountDeletion,
    cause: unknown,
  ) {
    super("Relay data deleted; finish deleting your account. Verify your identity and retry.", {
      cause,
    });
  }
}
const pending = new WeakMap<object, Promise<AccountDeletionResult>>();
export function advanceAccountDeletion(
  adapter: AccountDeletionAdapter,
  key: string,
  confirmed: boolean,
): Promise<AccountDeletionResult> {
  const active = pending.get(adapter.session);
  if (active) return active;
  const assertCurrent = () => {
    if (!adapter.isCurrent())
      throw new Error("Account or session changed. Resume deletion from the original account.");
  };
  const operation = (async () => {
    assertCurrent();
    const token = await adapter.getToken();
    assertCurrent();
    if (!token || decodeRelayJwt(token).sub !== adapter.accountId)
      throw new Error("The session does not match this account.");
    let relay = await adapter.getStatus(token);
    assertCurrent();
    if (relay.status === "absent" && confirmed) {
      relay = await adapter.requestDelete(token, key);
      assertCurrent();
    }
    if (
      relay.status === "absent" ||
      (relay.status === "progress" && relay.relayState !== "erased") ||
      !confirmed
    )
      return { relay, identityDeleted: false };
    if (relay.status === "progress" && relay.identityAction === "already_deleted")
      return { relay, identityDeleted: true };
    assertCurrent();
    try {
      await adapter.deleteIdentity();
    } catch (cause) {
      throw new AccountIdentityDeletionPendingError(relay, cause);
    }
    // Clerk's account-transition service owns cache cleanup; it captures the account that left.
    return { relay, identityDeleted: true };
  })();
  pending.set(adapter.session, operation);
  void operation
    .finally(() => {
      if (pending.get(adapter.session) === operation) pending.delete(adapter.session);
    })
    .catch(() => undefined);
  return operation;
}
export function accountDeletionMessage(result: AccountDeletionResult): string {
  if (result.relay.status === "absent") return "No account deletion has been requested.";
  if (result.relay.status === "deleted")
    return result.identityDeleted
      ? `Your GOAT Connect account was deleted on ${result.relay.deletedAt}.`
      : `Relay data was deleted on ${result.relay.deletedAt}. Finish deleting your account.`;
  const progress = result.relay;
  const state =
    progress.relayState === "erasing"
      ? "Deleting relay data. Refresh status to continue."
      : result.identityDeleted
        ? "Your GOAT Connect account is deleted."
        : "Relay data deleted; finish deleting your account.";
  return `${state} ${progress.hostCleanup.pending} machines have not confirmed local cleanup; their existing sessions can remain until they reconnect or you unlink them locally. Older machines require an update or local unlink. If a machine stays offline until the beta ends, unlink it locally.${progress.endpointCleanup === "pending" ? " Provider tunnel cleanup remains unconfirmed." : ""}`;
}
