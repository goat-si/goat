import { EndpointIdentity } from "./EndpointIdentity.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { RelayAuthorizationUnavailableError } from "@goat/contracts/relayErrors";
import { RelayDb } from "../db.ts";
import { AccountAccess, type AccountAccessError } from "../accounts/AccountAccess.ts";
import { AccountTransactions } from "../accounts/AccountTransactions.ts";
import { RelayConfiguration } from "../Config.ts";
import type { ManagedEndpointAllocation } from "./ManagedEndpointAllocations.ts";

export class ManagedProvisioningIntents extends Context.Service<
  ManagedProvisioningIntents,
  {
    readonly prepare: (
      allocation: ManagedEndpointAllocation,
    ) => Effect.Effect<string, AccountAccessError>;
    readonly record: (input: {
      readonly intentId: string;
      readonly tunnelId: string;
      readonly recorded: boolean;
    }) => Effect.Effect<void, RelayAuthorizationUnavailableError>;
  }
>()("goat-relay/environments/ManagedProvisioningIntents") {}
const make = Effect.gen(function* () {
  const db = yield* RelayDb;
  const sql = db.$client;
  const access = yield* AccountAccess;
  const identity = yield* EndpointIdentity;
  const tx = yield* AccountTransactions;
  const config = yield* RelayConfiguration;
  return ManagedProvisioningIntents.of({
    prepare: Effect.fn("ManagedProvisioningIntents.prepare")(function* (a) {
      const admitted = yield* access.admit(a.userId);
      return yield* tx
        .run(
          { userIds: [a.userId] },
          Effect.gen(function* () {
            yield* access.requireAllowed(admitted);
            yield* identity
              .check({
                ...admitted,
                incarnationId: a.incarnationId,
                endpointGeneration: a.endpointGeneration,
                generation: a.generation,
              })
              .pipe(
                Effect.catchTags({
                  RelayEnvironmentOwnerMismatchError: () =>
                    Effect.fail(
                      new RelayAuthorizationUnavailableError({
                        code: "authorization_unavailable",
                        traceId: "unavailable",
                      }),
                    ),
                }),
              );
            const [owner] = yield* sql<{
              environment_public_key: string;
            }>`SELECT environment_public_key FROM relay_environment_owners WHERE user_id=${a.userId} AND environment_id=${a.environmentId} AND account_epoch=${admitted.accountEpoch} AND state IN ('pending','active')`;
            if (!owner)
              return yield* new RelayAuthorizationUnavailableError({
                code: "authorization_unavailable",
                traceId: "relay",
              });
            const [intent] = yield* sql<{
              id: string;
            }>`INSERT INTO relay_managed_provisioning_intents(stage,endpoint_key,user_id,environment_id,environment_public_key,account_epoch,allocation_incarnation_id,allocation_generation,tunnel_name,state) VALUES (${config.managedEndpointNamespace ?? ""},${a.tunnelName.slice(-16)},${a.userId},${a.environmentId},${owner.environment_public_key},${admitted.accountEpoch},${a.incarnationId},${a.generation},${a.tunnelName},'intent') ON CONFLICT(stage,endpoint_key) WHERE state IN ('intent','created') DO UPDATE SET updated_at=now() WHERE relay_managed_provisioning_intents.allocation_incarnation_id=excluded.allocation_incarnation_id AND relay_managed_provisioning_intents.account_epoch=excluded.account_epoch RETURNING id`;
            if (!intent)
              return yield* new RelayAuthorizationUnavailableError({
                code: "authorization_unavailable",
                traceId: "relay",
              });
            return intent.id;
          }),
        )
        .pipe(
          Effect.mapError((e) =>
            e._tag === "SqlError"
              ? new RelayAuthorizationUnavailableError({
                  code: "authorization_unavailable",
                  traceId: "relay",
                })
              : e,
          ),
        );
    }),
    record: Effect.fn("ManagedProvisioningIntents.record")(function* (input) {
      yield* sql`UPDATE relay_managed_provisioning_intents SET tunnel_id=${input.tunnelId},state=CASE WHEN state='abandoned' THEN 'abandoned' ELSE ${input.recorded ? "recorded" : "created"} END,updated_at=now() WHERE id=${input.intentId}`.pipe(
        Effect.mapError(
          () =>
            new RelayAuthorizationUnavailableError({
              code: "authorization_unavailable",
              traceId: "relay",
            }),
        ),
      );
    }),
  });
});
export const layer = Layer.effect(ManagedProvisioningIntents, make);
