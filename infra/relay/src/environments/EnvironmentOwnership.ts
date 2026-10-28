import {
  RelayEnvironmentOwnerConflictError,
  RelayAccountResourceLimitExceededError,
  RelayEnvironmentOwnerMismatchError,
  RelayAuthorizationUnavailableError,
} from "@goat/contracts/relayErrors";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { RelayDb } from "../db.ts";
import {
  AccountAccess,
  type AccountAdmission,
  type AccountAccessError,
} from "../accounts/AccountAccess.ts";
import { AccountLimits } from "../accounts/AccountLimits.ts";
import { AccountTransactions } from "../accounts/AccountTransactions.ts";

export type OwnershipError =
  | RelayEnvironmentOwnerMismatchError
  | AccountAccessError
  | RelayEnvironmentOwnerConflictError
  | RelayAccountResourceLimitExceededError;
export interface OwnershipReleaseClaim {
  readonly claimId: string;
  readonly environmentPublicKey: string;
}
export class EnvironmentOwnership extends Context.Service<
  EnvironmentOwnership,
  {
    readonly beginRelease: (input: {
      readonly userId: string;
      readonly environmentId: string;
    }) => Effect.Effect<ReadonlyArray<OwnershipReleaseClaim>, RelayAuthorizationUnavailableError>;
    readonly finishRelease: (input: {
      readonly userId: string;
      readonly environmentId: string;
      readonly claims: ReadonlyArray<OwnershipReleaseClaim>;
    }) => Effect.Effect<boolean, RelayAuthorizationUnavailableError>;
    readonly assertActive: (
      input: AccountAdmission & {
        readonly environmentId: string;
        readonly environmentPublicKey: string;
      },
    ) => Effect.Effect<void, AccountAccessError | RelayEnvironmentOwnerMismatchError>;
    readonly claim: (
      input: AccountAdmission & {
        readonly environmentId: string;
        readonly environmentPublicKey: string;
      },
    ) => Effect.Effect<void, OwnershipError>;
  }
>()("goat-relay/environments/EnvironmentOwnership") {}
const make = Effect.gen(function* () {
  const db = yield* RelayDb;
  const access = yield* AccountAccess;
  const transactions = yield* AccountTransactions;
  const limits = yield* AccountLimits;
  const sql = db.$client;
  return EnvironmentOwnership.of({
    beginRelease: Effect.fn("EnvironmentOwnership.beginRelease")(function* (input) {
      return yield* transactions
        .run(
          { userIds: [input.userId] },
          Effect.gen(function* () {
            const claims = yield* sql<{
              claim_id: string;
              environment_public_key: string;
            }>`UPDATE relay_environment_owners SET state='releasing',updated_at=now() WHERE user_id=${input.userId} AND environment_id=${input.environmentId} RETURNING claim_id,environment_public_key`;
            return claims.map((row) => ({
              claimId: row.claim_id,
              environmentPublicKey: row.environment_public_key,
            }));
          }),
        )
        .pipe(
          Effect.mapError(
            () =>
              new RelayAuthorizationUnavailableError({
                code: "authorization_unavailable",
                traceId: "unavailable",
              }),
          ),
        );
    }),
    finishRelease: Effect.fn("EnvironmentOwnership.finishRelease")(function* (input) {
      return yield* transactions
        .run(
          {
            userIds: [input.userId],
            environmentPublicKeys: input.claims.map((c) => c.environmentPublicKey),
          },
          Effect.gen(function* () {
            const [held] = yield* sql<{
              held: boolean;
            }>`SELECT EXISTS(SELECT 1 FROM relay_environment_links WHERE user_id=${input.userId} AND environment_id=${input.environmentId} AND revoked_at IS NULL UNION ALL SELECT 1 FROM relay_managed_endpoint_allocations WHERE user_id=${input.userId} AND environment_id=${input.environmentId} AND capacity_released_at IS NULL UNION ALL SELECT 1 FROM relay_managed_provisioning_intents WHERE user_id=${input.userId} AND environment_id=${input.environmentId} AND state IN ('intent','created')) AS held`;
            if (held?.held) return false;
            yield* sql`DELETE FROM relay_environment_owners WHERE user_id=${input.userId} AND environment_id=${input.environmentId} AND state='releasing' AND ${sql.in(
              "claim_id",
              input.claims.map((c) => c.claimId),
            )}`;
            return true;
          }),
        )
        .pipe(
          Effect.mapError(
            () =>
              new RelayAuthorizationUnavailableError({
                code: "authorization_unavailable",
                traceId: "unavailable",
              }),
          ),
        );
    }),
    assertActive: Effect.fn("EnvironmentOwnership.assertActive")(function* (input) {
      yield* access.requireAllowed(input);
      const [row] = yield* sql<{
        valid: boolean;
      }>`SELECT EXISTS(SELECT 1 FROM relay_environment_owners o JOIN relay_environment_links l ON l.user_id=o.user_id AND l.environment_id=o.environment_id AND l.environment_public_key=o.environment_public_key AND l.account_epoch=o.account_epoch WHERE o.environment_public_key=${input.environmentPublicKey} AND o.user_id=${input.userId} AND o.environment_id=${input.environmentId} AND o.account_epoch=${input.accountEpoch} AND o.state='active' AND l.revoked_at IS NULL) AS valid`.pipe(
        Effect.mapError(
          () =>
            new RelayAuthorizationUnavailableError({
              code: "authorization_unavailable",
              traceId: "unavailable",
            }),
        ),
      );
      if (!row?.valid)
        return yield* new RelayEnvironmentOwnerMismatchError({
          code: "environment_owner_mismatch",
          traceId: "unavailable",
        });
    }),
    claim: Effect.fn("EnvironmentOwnership.claim")(function* (input) {
      yield* transactions
        .run(
          { userIds: [input.userId], environmentPublicKey: input.environmentPublicKey },
          Effect.gen(function* () {
            yield* access.requireAllowed(input);
            const owners = yield* sql<{
              user_id: string;
              environment_id: string;
              state: string;
            }>`SELECT user_id,environment_id,state FROM relay_environment_owners WHERE environment_public_key=${input.environmentPublicKey}`;
            const owner = owners[0];
            if (
              owner &&
              (owner.user_id !== input.userId ||
                owner.environment_id !== input.environmentId ||
                owner.state === "releasing")
            )
              return yield* new RelayEnvironmentOwnerConflictError({
                code: "environment_owner_conflict",
                traceId: "relay",
              });
            const [alias] = yield* sql<{
              exists: boolean;
            }>`SELECT EXISTS(SELECT 1 FROM relay_environment_owners WHERE user_id=${input.userId} AND environment_id=${input.environmentId} AND environment_public_key<>${input.environmentPublicKey}) AS exists`;
            if (alias?.exists)
              return yield* new RelayEnvironmentOwnerConflictError({
                code: "environment_owner_conflict",
                traceId: "unavailable",
              });
            const [counts] = yield* sql<{
              used: number;
              existing: boolean;
            }>`SELECT count(*)::integer AS used,coalesce(bool_or(environment_id=${input.environmentId}),false) AS existing FROM relay_environment_links WHERE user_id=${input.userId} AND revoked_at IS NULL`;
            if (counts && !counts.existing && counts.used >= limits.environmentLinks)
              return yield* new RelayAccountResourceLimitExceededError({
                code: "account_resource_limit_exceeded",
                resource: "environment_links",
                limit: limits.environmentLinks,
                traceId: "relay",
              });
            yield* sql`INSERT INTO relay_environment_owners(environment_public_key,user_id,environment_id,account_epoch,state) VALUES (${input.environmentPublicKey},${input.userId},${input.environmentId},${input.accountEpoch},'pending') ON CONFLICT(environment_public_key) DO UPDATE SET account_epoch=excluded.account_epoch,updated_at=now()`;
          }),
        )
        .pipe(
          Effect.mapError((error) =>
            error._tag === "SqlError"
              ? new RelayAuthorizationUnavailableError({
                  code: "authorization_unavailable",
                  traceId: "relay",
                })
              : error,
          ),
        );
    }),
  });
});
export const layer = Layer.effect(EnvironmentOwnership, make);
