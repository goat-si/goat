import * as SqlError from "effect/sql/SqlError";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { RelayAuthorizationUnavailableError } from "@goat/contracts/relayErrors";
import { RelayDb } from "../db.ts";
import { AccountRequestAdmission } from "../accounts/AccountAccess.ts";
import { AccountTransactions } from "../accounts/AccountTransactions.ts";

export interface DeliveryTarget {
  readonly userId: string;
  readonly deviceId: string;
  readonly accountEpoch: number | null;
  readonly token: string;
  readonly kind:
    | "push_notification"
    | "live_activity_start"
    | "live_activity_update"
    | "live_activity_end";
}
export const DeliveryContext = Context.Reference<DeliveryTarget | undefined>(
  "goat-relay/agentActivity/DeliveryContext",
  { defaultValue: () => undefined },
);
export class DeliveryAuthorization extends Context.Service<
  DeliveryAuthorization,
  {
    readonly eligible: (
      target: DeliveryTarget,
    ) => Effect.Effect<boolean, RelayAuthorizationUnavailableError>;
    readonly result: <E, R>(
      effect: Effect.Effect<void, E, R>,
    ) => Effect.Effect<void, E | RelayAuthorizationUnavailableError, R>;
  }
>()("goat-relay/agentActivity/DeliveryAuthorization") {}
const make = Effect.gen(function* () {
  const db = yield* RelayDb;
  const sql = db.$client;
  const tx = yield* AccountTransactions;
  const eligible = Effect.fn("DeliveryAuthorization.eligible")(function* (target: DeliveryTarget) {
    const admitted = yield* AccountRequestAdmission;
    if (
      target.accountEpoch === null ||
      (admitted &&
        (admitted.userId !== target.userId || admitted.accountEpoch !== target.accountEpoch))
    )
      return false;
    const [row] = yield* sql<{
      allowed: boolean;
    }>`SELECT EXISTS(SELECT 1 FROM relay_account_access a JOIN relay_mobile_devices d ON d.user_id=a.user_id AND d.account_epoch=a.account_epoch LEFT JOIN relay_live_activities l ON l.user_id=d.user_id AND l.device_id=d.device_id AND l.account_epoch=d.account_epoch AND l.delivery_disabled_at IS NULL WHERE a.user_id=${target.userId} AND a.status='allowed' AND a.account_epoch=${target.accountEpoch} AND d.device_id=${target.deviceId} AND d.delivery_disabled_at IS NULL AND CASE ${target.kind} WHEN 'push_notification' THEN d.push_token=${target.token} WHEN 'live_activity_start' THEN d.push_to_start_token=${target.token} ELSE l.activity_push_token=${target.token} END) AS allowed`.pipe(
      Effect.mapError(
        () =>
          new RelayAuthorizationUnavailableError({
            code: "authorization_unavailable",
            traceId: "relay",
          }),
      ),
    );
    return row?.allowed === true;
  });
  return DeliveryAuthorization.of({
    eligible,
    result: Effect.fn("DeliveryAuthorization.result")(function* (effect) {
      const target = yield* DeliveryContext;
      if (!target)
        return yield* new RelayAuthorizationUnavailableError({
          code: "authorization_unavailable",
          traceId: "relay",
        });
      yield* tx
        .run(
          { userIds: [target.userId] },
          eligible(target).pipe(Effect.flatMap((allowed) => (allowed ? effect : Effect.void))),
        )
        .pipe(
          Effect.mapError((error) =>
            SqlError.isSqlError(error)
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
export const layer = Layer.effect(DeliveryAuthorization, make);
