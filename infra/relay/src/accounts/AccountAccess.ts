import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  RelayAccountAccessDeniedError,
  RelayAccountEpochStaleError,
  RelayAuthorizationUnavailableError,
} from "@goat/contracts/relayErrors";
import { subjectDigest } from "./SubjectDigest.ts";
import { RelayConfiguration } from "../Config.ts";
import { RelayMintDisabledError } from "@goat/contracts/relayErrors";
import { RelayDb } from "../db.ts";

export interface AccountAdmission {
  readonly userId: string;
  readonly accountEpoch: number;
}
export const AccountRequestAdmission = Context.Reference<AccountAdmission | undefined>(
  "goat-relay/accounts/AccountRequestAdmission",
  { defaultValue: () => undefined },
);
export type AccountAccessError =
  | RelayMintDisabledError
  | RelayAccountAccessDeniedError
  | RelayAccountEpochStaleError
  | RelayAuthorizationUnavailableError;
export class AccountAccess extends Context.Service<
  AccountAccess,
  {
    readonly admit: (userId: string) => Effect.Effect<AccountAdmission, AccountAccessError>;
    readonly capture: (userId: string) => Effect.Effect<AccountAdmission, AccountAccessError>;
    readonly requireAllowed: (input: {
      readonly userId: string;
      readonly accountEpoch: number | undefined;
      readonly credentialKind?: "dpop" | "link_challenge" | "environment";
    }) => Effect.Effect<AccountAdmission, AccountAccessError>;
  }
>()("goat-relay/accounts/AccountAccess") {}

const make = Effect.gen(function* () {
  const db = yield* RelayDb;
  const config = yield* RelayConfiguration;
  const read = Effect.fn("AccountAccess.read")(function* (userId: string) {
    const digest = yield* subjectDigest(userId).pipe(
      Effect.provideService(RelayConfiguration, config),
    );
    const rows = yield* db.$client<{
      status: "allowed" | "suspended" | "deleted";
      deletion_requested_at: string | null;
      account_epoch: number;
    }>`SELECT status,account_epoch,deletion_requested_at FROM relay_account_access WHERE subject_digest=${digest} OR (subject_digest IS NULL AND user_id=${userId})`.pipe(
      Effect.mapError(
        () =>
          new RelayAuthorizationUnavailableError({
            code: "authorization_unavailable",
            traceId: "relay",
          }),
      ),
    );
    const row = rows[0];
    if (!row || row.status !== "allowed" || row.deletion_requested_at)
      return yield* new RelayAccountAccessDeniedError({
        code: "account_access_denied",
        reason:
          row?.status === "deleted" || row?.deletion_requested_at
            ? "account_deleted"
            : row
              ? "suspended"
              : "not_invited",
        traceId: "relay",
      });
    return { userId, accountEpoch: row.account_epoch };
  });
  const requireAllowed: AccountAccess["Service"]["requireAllowed"] = Effect.fn(
    "AccountAccess.requireAllowed",
  )(function* (input) {
    const current = yield* read(input.userId);
    if (current.accountEpoch !== input.accountEpoch) {
      const credentialKind = input.credentialKind ?? "environment";
      return yield* new RelayAccountEpochStaleError({
        code: "account_epoch_stale",
        credentialKind,
        action:
          credentialKind === "dpop"
            ? "refresh_token"
            : credentialKind === "link_challenge"
              ? "new_challenge"
              : "relink",
        traceId: "relay",
      });
    }
    return current;
  });
  return AccountAccess.of({
    capture: read,
    requireAllowed,
    admit: Effect.fn("AccountAccess.admit")(function* (userId) {
      const captured = yield* AccountRequestAdmission;
      return captured
        ? yield* requireAllowed({
            ...captured,
            userId,
            accountEpoch: captured.userId === userId ? captured.accountEpoch : undefined,
          })
        : yield* read(userId);
    }),
  });
});
export const layer = Layer.effect(AccountAccess, make);
