// @effect-diagnostics nodeBuiltinImport:off -- Worker-compatible hashes match environment credential authentication.
import { createHash } from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { RelayAuthorizationUnavailableError } from "@goat/contracts/relayErrors";
import { RelayDb } from "../db.ts";
import { receiptId } from "./SubjectDigest.ts";
import { RelayConfiguration } from "../Config.ts";
import { RelayRateLimits } from "./RelayRateLimits.ts";

export function hostTargetDigest(environmentId: string, publicKey: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "goat-host-revocation:v1",
        environmentId,
        publicKey.replace(/\r\n/gu, "\n").trim(),
      ]),
    )
    .digest("hex");
}
export class AccountErasure extends Context.Service<
  AccountErasure,
  {
    readonly capture: (
      userId: string,
      digest: string,
    ) => Effect.Effect<void, RelayAuthorizationUnavailableError>;
    readonly closeCounters: (
      userId: string,
      digest: string,
    ) => Effect.Effect<void, RelayAuthorizationUnavailableError>;
    readonly purge: (
      userId: string,
      digest: string,
      operationId: string,
    ) => Effect.Effect<void, RelayAuthorizationUnavailableError>;
  }
>()("goat-relay/accounts/AccountErasure") {}
const unavailable = () =>
  new RelayAuthorizationUnavailableError({ code: "authorization_unavailable", traceId: "relay" });
const make = Effect.gen(function* () {
  const db = yield* RelayDb;
  const sql = db.$client;
  const config = yield* RelayConfiguration;
  const rates = yield* RelayRateLimits;
  return AccountErasure.of({
    capture: Effect.fn("AccountErasure.capture")(function* (userId, digest) {
      const credentials = yield* sql<{
        credential_hash: string;
        environment_id: string;
        environment_public_key: string;
      }>`
        SELECT credential_hash,environment_id,environment_public_key FROM relay_environment_credentials
        WHERE user_id=${userId} OR (user_id IS NULL AND environment_public_key IN
          (SELECT environment_public_key FROM relay_environment_owners WHERE user_id=${userId}
           UNION SELECT environment_public_key FROM relay_environment_links WHERE user_id=${userId}))`;
      for (const credential of credentials) {
        const target = hostTargetDigest(
          credential.environment_id,
          credential.environment_public_key,
        );
        const id = yield* receiptId(credential.credential_hash, target).pipe(
          Effect.provideService(RelayConfiguration, config),
        );
        yield* sql`INSERT INTO relay_host_revocations(id,subject_digest,credential_digest,target_digest)
          VALUES (${id},${digest},${credential.credential_hash},${target}) ON CONFLICT(credential_digest) DO NOTHING`;
      }
    }, Effect.mapError(unavailable)),
    closeCounters: Effect.fn("AccountErasure.closeCounters")(function* (userId, digest) {
      if (!rates.close) return yield* unavailable();
      yield* rates.close(userId, digest);
    }),
    purge: Effect.fn("AccountErasure.purge")(function* (userId, digest, operationId) {
      const [ambiguous] = yield* sql<{
        present: boolean;
      }>`SELECT EXISTS(SELECT 1 FROM relay_delivery_attempts WHERE user_id IS NULL AND environment_id IN (SELECT environment_id FROM relay_environment_links WHERE user_id=${userId})) AS present`;
      if (ambiguous?.present) return yield* unavailable();
      // Legacy rows are key-scoped; the captured ownership graph, never a public environment id, proves ownership.
      yield* sql`DELETE FROM relay_agent_activity_rows WHERE owner_user_id=${userId} OR
        (owner_user_id IS NULL AND environment_public_key IN
          (SELECT environment_public_key FROM relay_environment_links WHERE user_id=${userId}
           UNION SELECT environment_public_key FROM relay_account_operation_resources WHERE owner_user_id=${userId} AND environment_public_key IS NOT NULL))`;
      yield* sql`DELETE FROM relay_delivery_attempts WHERE user_id=${userId}`;
      yield* sql`DELETE FROM relay_live_activities WHERE user_id=${userId}`;
      yield* sql`DELETE FROM relay_mobile_devices WHERE user_id=${userId}`;
      yield* sql`DELETE FROM relay_environment_credentials WHERE user_id=${userId} OR
        (user_id IS NULL AND environment_public_key IN
          (SELECT environment_public_key FROM relay_environment_links WHERE user_id=${userId}
           UNION SELECT environment_public_key FROM relay_account_operation_resources WHERE owner_user_id=${userId} AND environment_public_key IS NOT NULL))`;
      yield* sql`DELETE FROM relay_environment_links WHERE user_id=${userId}`;
      yield* sql`DELETE FROM relay_managed_provisioning_intents WHERE user_id=${userId}`;
      yield* sql`DELETE FROM relay_managed_endpoint_allocations WHERE user_id=${userId}`;
      yield* sql`DELETE FROM relay_environment_owners WHERE user_id=${userId}`;
      yield* sql`DELETE FROM relay_endpoint_identities WHERE user_id=${userId}`;
      yield* sql`DELETE FROM relay_managed_tunnel_limits WHERE user_id=${userId}`;
      yield* sql`DELETE FROM relay_client_keys WHERE user_id=${userId}`;
      yield* sql`DELETE FROM relay_connect_link_reservations WHERE user_id=${userId}`;
      yield* sql`UPDATE relay_retired_endpoints SET subject_digest=${digest},user_id=NULL,environment_id=NULL,tunnel_id=NULL,dns_record_id=NULL WHERE user_id=${userId}`;
      yield* sql`DELETE FROM relay_account_operation_resources WHERE owner_user_id=${userId}`;
      yield* sql`DELETE FROM relay_account_operation_requests WHERE user_id=${userId}`;
      yield* sql`DELETE FROM relay_account_operations WHERE user_id=${userId} AND id<>${operationId}`;
      yield* sql`UPDATE relay_account_operations SET user_id=NULL,idempotency_key='erased',request_hash='delete',last_error_code=NULL WHERE id=${operationId}`;
      yield* sql`UPDATE relay_account_access SET status='deleted',user_id=NULL,relay_erased_at=now(),updated_at=now() WHERE subject_digest=${digest}`;
    }, Effect.mapError(unavailable)),
  });
});
export const layer = Layer.effect(AccountErasure, make);
