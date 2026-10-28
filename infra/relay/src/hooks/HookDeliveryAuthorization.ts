import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { RelayAuthorizationUnavailableError } from "@goat/contracts/relayErrors";
import { RelayDb } from "../db.ts";

export const HookAuthorization = Schema.Struct({
  userId: Schema.String,
  accountEpoch: Schema.Int.check(Schema.isGreaterThan(0)),
  environmentId: Schema.String,
  environmentPublicKey: Schema.String,
  incarnationId: Schema.String,
});
export type HookAuthorization = typeof HookAuthorization.Type;
export class HookDeliveryAuthorization extends Context.Service<
  HookDeliveryAuthorization,
  {
    readonly allowed: (
      authorization: HookAuthorization | undefined,
    ) => Effect.Effect<boolean, RelayAuthorizationUnavailableError>;
  }
>()("goat-relay/hooks/HookDeliveryAuthorization") {}
const make = Effect.gen(function* () {
  const db = yield* RelayDb;
  return HookDeliveryAuthorization.of({
    allowed: Effect.fn("HookDeliveryAuthorization.allowed")(function* (input) {
      if (!input) return false;
      const [row] = yield* db.$client<{
        allowed: boolean;
      }>`SELECT EXISTS(SELECT 1 FROM relay_account_access a JOIN relay_environment_links l ON l.user_id=a.user_id AND l.account_epoch=a.account_epoch JOIN relay_environment_owners o ON o.user_id=l.user_id AND o.environment_id=l.environment_id AND o.environment_public_key=l.environment_public_key AND o.account_epoch=a.account_epoch AND o.state='active' JOIN relay_managed_endpoint_allocations m ON m.user_id=l.user_id AND m.environment_id=l.environment_id AND m.account_epoch=a.account_epoch WHERE a.user_id=${input.userId} AND a.status='allowed' AND a.account_epoch=${input.accountEpoch} AND l.environment_id=${input.environmentId} AND l.environment_public_key=${input.environmentPublicKey} AND l.revoked_at IS NULL AND m.incarnation_id=${input.incarnationId} AND m.deleted_at IS NULL) AS allowed`.pipe(
        Effect.mapError(
          () =>
            new RelayAuthorizationUnavailableError({
              code: "authorization_unavailable",
              traceId: "relay",
            }),
        ),
      );
      return row?.allowed === true;
    }),
  });
});
export const layer = Layer.effect(HookDeliveryAuthorization, make);
