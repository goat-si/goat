import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Hex from "effect/encoding/Hex";
import {
  RelayAuthorizationUnavailableError,
  RelayEnvironmentOwnerMismatchError,
} from "@goat/contracts/relayErrors";
import { RelayDb } from "../db.ts";
import {
  AccountAccess,
  type AccountAccessError,
  type AccountAdmission,
} from "../accounts/AccountAccess.ts";
import { AccountTransactions } from "../accounts/AccountTransactions.ts";
import { RelayConfiguration } from "../Config.ts";
import {
  managedEndpointDigestInput,
  managedEndpointHostname,
  managedEndpointTunnelName,
} from "../deploymentConfig.ts";

export class EndpointIdentity extends Context.Service<
  EndpointIdentity,
  {
    readonly resolve: (input: {
      readonly userId: string;
      readonly environmentId: string;
    }) => Effect.Effect<
      {
        readonly endpointGeneration: number;
        readonly hostname: string;
        readonly tunnelName: string;
        readonly endpointKey: string;
      },
      AccountAccessError
    >;
    readonly check: (
      input: AccountAdmission & {
        readonly incarnationId: string;
        readonly endpointGeneration: number;
        readonly generation?: number;
        readonly tunnelId?: string | null;
      },
    ) => Effect.Effect<void, AccountAccessError | RelayEnvironmentOwnerMismatchError>;
  }
>()("goat-relay/environments/EndpointIdentity") {}
const make = Effect.gen(function* () {
  const db = yield* RelayDb;
  const sql = db.$client;
  const access = yield* AccountAccess;
  const tx = yield* AccountTransactions;
  const crypto = yield* Crypto.Crypto;
  const config = yield* RelayConfiguration;
  return EndpointIdentity.of({
    resolve: Effect.fn("EndpointIdentity.resolve")(function* (input) {
      const admitted = yield* access.admit(input.userId);
      const stage = config.managedEndpointNamespace;
      const baseDomain = config.managedEndpointBaseDomain;
      if (!stage || !baseDomain)
        return yield* new RelayAuthorizationUnavailableError({
          code: "authorization_unavailable",
          traceId: "relay",
        });
      const generation = yield* tx
        .run(
          { userIds: [input.userId] },
          Effect.gen(function* () {
            yield* access.requireAllowed(admitted);
            yield* sql`UPDATE relay_endpoint_identities SET stage=${stage} WHERE stage='__legacy__' AND user_id=${input.userId} AND environment_id=${input.environmentId}`;
            yield* sql`INSERT INTO relay_endpoint_identities(stage,user_id,environment_id) VALUES (${stage},${input.userId},${input.environmentId}) ON CONFLICT DO NOTHING`;
            const [identity] = yield* sql<{
              high_water_generation: number;
            }>`SELECT high_water_generation FROM relay_endpoint_identities WHERE stage=${stage} AND user_id=${input.userId} AND environment_id=${input.environmentId} FOR UPDATE`;
            if (!identity)
              return yield* new RelayAuthorizationUnavailableError({
                code: "authorization_unavailable",
                traceId: "relay",
              });
            return identity.high_water_generation;
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
      const hash = yield* crypto
        .digest(
          "SHA-256",
          new TextEncoder().encode(
            managedEndpointDigestInput(stage, input.userId, input.environmentId, generation),
          ),
        )
        .pipe(
          Effect.map(Hex.encode),
          Effect.mapError(
            () =>
              new RelayAuthorizationUnavailableError({
                code: "authorization_unavailable",
                traceId: "relay",
              }),
          ),
        );
      return {
        endpointGeneration: generation,
        hostname: managedEndpointHostname(stage, baseDomain, hash),
        tunnelName: managedEndpointTunnelName(stage, hash),
        endpointKey: hash.slice(0, 16),
      };
    }),
    check: Effect.fn("EndpointIdentity.check")(function* (input) {
      yield* tx
        .run(
          { userIds: [input.userId] },
          Effect.gen(function* () {
            yield* access.requireAllowed(input);
            const [row] = yield* sql<{
              generation: number;
              tunnel_id: string | null;
            }>`SELECT a.generation,a.tunnel_id FROM relay_managed_endpoint_allocations a JOIN relay_endpoint_identities i ON i.stage=${config.managedEndpointNamespace ?? ""} AND i.user_id=a.user_id AND i.environment_id=a.environment_id AND i.high_water_generation=a.endpoint_generation WHERE a.incarnation_id=${input.incarnationId} AND a.user_id=${input.userId} AND a.account_epoch=${input.accountEpoch} AND a.endpoint_generation=${input.endpointGeneration} AND a.deleted_at IS NULL AND a.capacity_released_at IS NULL AND EXISTS(SELECT 1 FROM relay_environment_owners o WHERE o.user_id=a.user_id AND o.environment_id=a.environment_id AND o.account_epoch=a.account_epoch AND o.state IN ('pending','active')) AND NOT EXISTS(SELECT 1 FROM relay_retired_endpoints r WHERE r.tunnel_name=a.tunnel_name)`;
            if (
              !row ||
              (input.generation !== undefined && row.generation !== input.generation) ||
              (input.tunnelId !== undefined && row.tunnel_id !== input.tunnelId)
            )
              return yield* new RelayEnvironmentOwnerMismatchError({
                code: "environment_owner_mismatch",
                traceId: "relay",
              });
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
  });
});
export const layer = Layer.effect(EndpointIdentity, make);
