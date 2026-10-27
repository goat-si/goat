import { subjectDigest } from "./SubjectDigest.ts";
import { AccountErasure } from "./AccountErasure.ts";
import { type RelayAccountDeletionStatus, type RelayAccountDeletion } from "@goat/contracts/relay";
import { AccountOperationProgress, operationProgress } from "./AccountOperationProgress.ts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { RelayAuthorizationUnavailableError } from "@goat/contracts/relayErrors";
import { RelayDb } from "../db.ts";
import { AccountTransactions } from "./AccountTransactions.ts";
import { RelayConfiguration } from "../Config.ts";
import {
  managedEndpointDigestInput,
  managedEndpointHostname,
  managedEndpointTunnelName,
} from "../deploymentConfig.ts";
import { HookInbox } from "../hooks/HookInbox.ts";

export class AccountLifecycleConflict extends Schema.TaggedError<AccountLifecycleConflict>()(
  "AccountLifecycleConflict",
  {
    code: Schema.Literals([
      "operation_in_progress",
      "idempotency_conflict",
      "cleanup_pending",
      "epoch_exhausted",
      "operation_not_found",
      "account_deleted",
    ]),
  },
) {}
export interface AccountOperation {
  readonly id: string;
  readonly user_id: string | null;
  readonly subject_digest: string;
  readonly identity_deleted: number;
  readonly host_acknowledged: number;
  readonly kind: "suspend" | "allow" | "delete";
  readonly account_epoch: number;
  readonly expected_epoch: number;
  readonly state: "pending" | "running" | "completed" | "superseded";
  readonly completed_at: string | null;
  readonly claim_version: number;
  readonly next_attempt_at: string;
  readonly last_error_code: string | null;
  readonly step_state: AccountOperationProgress;
}
type LifecycleError = AccountLifecycleConflict | RelayAuthorizationUnavailableError;
export class AccountLifecycle extends Context.Service<
  AccountLifecycle,
  {
    readonly request: (input: {
      readonly userId: string;
      readonly kind: "suspend" | "allow" | "delete";
      readonly idempotencyKey: string;
    }) => Effect.Effect<AccountOperation, LifecycleError>;
    readonly resume: (id: string) => Effect.Effect<AccountOperation, LifecycleError>;
    readonly getOperation: (id: string) => Effect.Effect<AccountOperation, LifecycleError>;
    readonly getAccount: (userId: string) => Effect.Effect<
      {
        readonly status: string;
        readonly accountEpoch: number | null;
        readonly operations: ReadonlyArray<AccountOperation>;
      },
      LifecycleError
    >;
    readonly requestDelete: (input: {
      readonly userId: string;
      readonly idempotencyKey: string;
      readonly identityDeleted?: boolean;
    }) => Effect.Effect<RelayAccountDeletion, LifecycleError>;
    readonly getDeletion: (
      userId: string,
    ) => Effect.Effect<RelayAccountDeletionStatus, LifecycleError>;
    readonly scanPending: Effect.Effect<void, RelayAuthorizationUnavailableError>;
  }
>()("goat-relay/accounts/AccountLifecycle") {}
const operationColumns =
  "id,user_id,subject_digest,identity_deleted,host_acknowledged,kind,account_epoch,expected_epoch,state,completed_at,claim_version,next_attempt_at,last_error_code,step_state";
const make = Effect.gen(function* () {
  const db = yield* RelayDb;
  const erasure = yield* AccountErasure;
  const sql = db.$client;
  const tx = yield* AccountTransactions;
  const crypto = yield* Crypto.Crypto;
  const config = yield* RelayConfiguration;
  const inbox = yield* HookInbox;
  const unavailable = () =>
    new RelayAuthorizationUnavailableError({ code: "authorization_unavailable", traceId: "relay" });
  const getOperation = Effect.fn("AccountLifecycle.getOperation")(function* (id: string) {
    const rows =
      yield* sql<AccountOperation>`SELECT ${sql.literal(operationColumns)} FROM relay_account_operations WHERE id=${id}`.pipe(
        Effect.mapError(unavailable),
      );
    if (!rows[0]) return yield* new AccountLifecycleConflict({ code: "operation_not_found" });
    yield* Schema.decodeEffect(AccountOperationProgress)(rows[0].step_state).pipe(
      Effect.mapError(unavailable),
    );
    return rows[0];
  });
  const request = Effect.fn("AccountLifecycle.request")(function* (input: {
    readonly userId: string;
    readonly kind: "suspend" | "allow" | "delete";
    readonly idempotencyKey: string;
  }) {
    const digest = yield* subjectDigest(input.userId).pipe(
      Effect.provideService(RelayConfiguration, config),
    );
    const result = yield* tx
      .run(
        { userIds: [input.userId] },
        Effect.gen(function* () {
          const [terminal] = yield* sql<{
            deletion_requested_at: string | null;
            status: string;
          }>`SELECT deletion_requested_at,status FROM relay_account_access WHERE subject_digest=${digest}`;
          if (
            (terminal?.deletion_requested_at || terminal?.status === "deleted") &&
            input.kind !== "delete"
          )
            return yield* new AccountLifecycleConflict({ code: "account_deleted" });
          const [duplicate] = yield* sql<
            AccountOperation & { request_hash: string }
          >`SELECT ${sql.literal(operationColumns)},request_hash FROM relay_account_operations WHERE subject_digest=${digest} AND (idempotency_key=${input.idempotencyKey} OR id IN (SELECT operation_id FROM relay_account_operation_requests WHERE subject_digest=${digest} AND idempotency_key=${input.idempotencyKey}))`;
          if (duplicate) {
            if (duplicate.request_hash !== input.kind)
              return yield* new AccountLifecycleConflict({ code: "idempotency_conflict" });
            return duplicate.id;
          }
          if (input.kind === "delete") {
            const [canonical] = yield* sql<{
              id: string;
            }>`SELECT id FROM relay_account_operations WHERE subject_digest=${digest} AND kind='delete' LIMIT 1`;
            if (canonical) return canonical.id;
            if (terminal?.status === "deleted")
              return yield* new AccountLifecycleConflict({ code: "account_deleted" });
          }
          const [pending] = yield* sql<{
            id: string;
            kind: "suspend" | "allow" | "delete";
          }>`SELECT id,kind FROM relay_account_operations WHERE subject_digest=${digest} AND completed_at IS NULL`;
          if (pending && input.kind === "delete" && pending.kind !== "delete") {
            yield* sql`UPDATE relay_account_operations SET state='superseded',completed_at=now(),claim_version=claim_version+1,lease_owner=NULL,lease_expires_at=NULL WHERE id=${pending.id}`;
          } else if (pending) {
            if (pending.kind !== input.kind)
              return yield* new AccountLifecycleConflict({ code: "operation_in_progress" });
            yield* sql`INSERT INTO relay_account_operation_requests(user_id,subject_digest,idempotency_key,operation_id) VALUES (${input.userId},${digest},${input.idempotencyKey},${pending.id})`;
            return pending.id;
          }
          const [current] = yield* sql<{
            status: "allowed" | "suspended" | "deleted";
            account_epoch: number;
          }>`SELECT status,account_epoch FROM relay_account_access WHERE subject_digest=${digest} FOR UPDATE`;
          const same =
            input.kind !== "delete" &&
            current?.status === (input.kind === "allow" ? "allowed" : "suspended");
          if (same) {
            const [canonical] = yield* sql<{
              id: string;
            }>`SELECT id FROM relay_account_operations WHERE subject_digest=${digest} AND kind=${input.kind} AND account_epoch=${current.account_epoch} ORDER BY created_at DESC LIMIT 1`;
            if (canonical) {
              yield* sql`INSERT INTO relay_account_operation_requests(user_id,subject_digest,idempotency_key,operation_id) VALUES (${input.userId},${digest},${input.idempotencyKey},${canonical.id})`;
              return canonical.id;
            }
          }
          const epoch = same ? current.account_epoch : (current?.account_epoch ?? 0) + 1;
          if (epoch > 2147483647)
            return yield* new AccountLifecycleConflict({ code: "epoch_exhausted" });
          if (input.kind === "allow" && !same) {
            const [remaining] = yield* sql<{
              pending: boolean;
            }>`SELECT EXISTS(SELECT 1 FROM relay_environment_owners WHERE user_id=${input.userId} AND state='releasing' UNION ALL SELECT 1 FROM relay_environment_links WHERE user_id=${input.userId} AND revoked_at IS NULL UNION ALL SELECT 1 FROM relay_environment_credentials WHERE user_id=${input.userId} AND revoked_at IS NULL UNION ALL SELECT 1 FROM relay_managed_provisioning_intents WHERE user_id=${input.userId} AND state IN ('intent','created') UNION ALL SELECT 1 FROM relay_mobile_devices WHERE user_id=${input.userId} AND delivery_disabled_at IS NULL UNION ALL SELECT 1 FROM relay_live_activities WHERE user_id=${input.userId} AND delivery_disabled_at IS NULL) AS pending`;
            if (remaining?.pending)
              return yield* new AccountLifecycleConflict({ code: "cleanup_pending" });
          }
          if (input.kind === "allow" && !current) {
            const [legacy] = yield* sql<{
              exists: boolean;
            }>`SELECT EXISTS(SELECT 1 FROM relay_environment_owners WHERE user_id=${input.userId} UNION ALL SELECT 1 FROM relay_managed_endpoint_allocations WHERE user_id=${input.userId} AND capacity_released_at IS NULL UNION ALL SELECT 1 FROM relay_mobile_devices WHERE user_id=${input.userId}) AS exists`;
            if (legacy?.exists)
              return yield* new AccountLifecycleConflict({ code: "cleanup_pending" });
          }
          const [operation] = yield* sql<{
            id: string;
          }>`INSERT INTO relay_account_operations(user_id,subject_digest,kind,account_epoch,expected_epoch,idempotency_key,request_hash,state,step_state,completed_at) VALUES (${input.userId},${digest},${input.kind},${epoch},${current?.account_epoch ?? 0},${input.idempotencyKey},${input.kind},${input.kind === "allow" || same ? "completed" : "pending"},${sql.json(operationProgress(input.kind, input.kind === "allow" || same))},${input.kind === "allow" || same ? DateTime.formatIso(yield* DateTime.now) : null}) RETURNING id`;
          if (!operation) return yield* unavailable();
          yield* sql`INSERT INTO relay_account_operation_requests(user_id,subject_digest,idempotency_key,operation_id) VALUES (${input.userId},${digest},${input.idempotencyKey},${operation.id})`;
          if (same) return operation.id;
          if (input.kind === "delete") yield* erasure.capture(input.userId, digest);
          if (input.kind === "suspend" || input.kind === "delete") {
            if (!config.managedEndpointNamespace) return yield* unavailable();
            yield* sql`UPDATE relay_endpoint_identities SET stage=${config.managedEndpointNamespace} WHERE user_id=${input.userId} AND stage='__legacy__'`;
            const identities = yield* sql<{
              stage: string;
              environment_id: string;
              high_water_generation: number;
            }>`SELECT stage,environment_id,high_water_generation FROM relay_endpoint_identities WHERE user_id=${input.userId} ORDER BY stage,environment_id FOR UPDATE`;
            for (const identity of identities) {
              if (identity.high_water_generation >= 2147483646)
                return yield* new AccountLifecycleConflict({ code: "epoch_exhausted" });
              if (!config.managedEndpointBaseDomain) return yield* unavailable();
              const hash = yield* crypto
                .digest(
                  "SHA-256",
                  new TextEncoder().encode(
                    managedEndpointDigestInput(
                      identity.stage,
                      input.userId,
                      identity.environment_id,
                      identity.high_water_generation,
                    ),
                  ),
                )
                .pipe(Effect.map(Hex.encode), Effect.mapError(unavailable));
              const [allocation] = yield* sql<{
                incarnation_id: string;
                tunnel_id: string | null;
                dns_record_id: string | null;
                hostname: string;
                generation: number;
                tunnel_name: string;
              }>`SELECT incarnation_id,tunnel_id,dns_record_id,hostname,generation,tunnel_name FROM relay_managed_endpoint_allocations WHERE user_id=${input.userId} AND environment_id=${identity.environment_id} AND endpoint_generation=${identity.high_water_generation} AND deleted_at IS NULL`;
              const name =
                allocation?.tunnel_name ?? managedEndpointTunnelName(identity.stage, hash);
              const hostname =
                allocation?.hostname ??
                managedEndpointHostname(identity.stage, config.managedEndpointBaseDomain, hash);
              yield* sql`INSERT INTO relay_retired_endpoints(stage,user_id,environment_id,generation,endpoint_key,tunnel_name,hostname,tunnel_id,dns_record_id) VALUES (${identity.stage},${input.userId},${identity.environment_id},${identity.high_water_generation},${name.slice(-16)},${name},${hostname},${allocation?.tunnel_id ?? null},${allocation?.dns_record_id ?? null})`;
              yield* sql`INSERT INTO relay_account_operation_resources(operation_id,resource_kind,resource_id,owner_user_id,resource_epoch,environment_id,allocation_incarnation_id,captured_generation,endpoint_key) VALUES (${operation.id},'hooks',${name},${input.userId},${current?.account_epoch ?? null},${identity.environment_id},${allocation?.incarnation_id ?? null},${allocation?.generation ?? null},${name.slice(-16)})`;
            }
            yield* sql`INSERT INTO relay_account_operation_resources(operation_id,resource_kind,resource_id,owner_user_id,resource_epoch,environment_id,environment_public_key,outcome) SELECT ${operation.id},'credential',credential_id,user_id,account_epoch,environment_id,environment_public_key,'done' FROM relay_environment_credentials WHERE user_id=${input.userId}`;
            yield* sql`INSERT INTO relay_account_operation_resources(operation_id,resource_kind,resource_id,owner_user_id,resource_epoch,environment_id,environment_public_key,outcome) SELECT ${operation.id},'owner',claim_id::text,user_id,account_epoch,environment_id,environment_public_key,'done' FROM relay_environment_owners WHERE user_id=${input.userId}`;
            yield* sql`INSERT INTO relay_account_operation_resources(operation_id,resource_kind,resource_id,owner_user_id,resource_epoch,outcome) SELECT ${operation.id},'device',device_id,user_id,account_epoch,'done' FROM relay_mobile_devices WHERE user_id=${input.userId}`;
            yield* sql`INSERT INTO relay_account_operation_resources(operation_id,resource_kind,resource_id,owner_user_id,resource_epoch,outcome) SELECT ${operation.id},'live_activity',device_id,user_id,account_epoch,'done' FROM relay_live_activities WHERE user_id=${input.userId}`;
            yield* sql`INSERT INTO relay_account_operation_resources(operation_id,resource_kind,resource_id,owner_user_id,resource_epoch,environment_id,allocation_incarnation_id,captured_generation,endpoint_key,outcome) SELECT ${operation.id},'allocation',incarnation_id::text,user_id,account_epoch,environment_id,incarnation_id,generation,right(tunnel_name,16),'done' FROM relay_managed_endpoint_allocations WHERE user_id=${input.userId} AND deleted_at IS NULL`;
            yield* sql`INSERT INTO relay_account_operation_resources(operation_id,resource_kind,resource_id,owner_user_id,resource_epoch,environment_id,allocation_incarnation_id,captured_generation,endpoint_key,outcome) SELECT ${operation.id},'intent',id::text,user_id,account_epoch,environment_id,allocation_incarnation_id,allocation_generation,endpoint_key,'done' FROM relay_managed_provisioning_intents WHERE user_id=${input.userId} AND state IN ('intent','created')`;
            if (input.kind === "delete")
              yield* sql`INSERT INTO relay_account_operation_resources(operation_id,resource_kind,resource_id,owner_user_id,endpoint_key)
              SELECT ${operation.id},'hooks',tunnel_name,${input.userId},endpoint_key FROM relay_retired_endpoints WHERE user_id=${input.userId} OR subject_digest=${digest} ON CONFLICT DO NOTHING`;
            yield* sql`UPDATE relay_endpoint_identities SET high_water_generation=high_water_generation+1 WHERE user_id=${input.userId}`;
            yield* sql`UPDATE relay_managed_endpoint_allocations SET deleted_at=now(),capacity_released_at=now(),generation=generation+1 WHERE user_id=${input.userId} AND deleted_at IS NULL`;
            yield* sql`UPDATE relay_managed_provisioning_intents SET state='abandoned',updated_at=now() WHERE user_id=${input.userId} AND state IN ('intent','created')`;
            yield* sql`UPDATE relay_environment_credentials SET revoked_at=now()::text,updated_at=now()::text WHERE user_id=${input.userId} AND revoked_at IS NULL`;
            yield* sql`UPDATE relay_environment_links SET revoked_at=now()::text,updated_at=now()::text WHERE user_id=${input.userId} AND revoked_at IS NULL`;
            yield* sql`UPDATE relay_environment_owners SET state='releasing',updated_at=now() WHERE user_id=${input.userId}`;
            yield* sql`DELETE FROM relay_agent_activity_rows WHERE owner_user_id=${input.userId}`;
            yield* sql`UPDATE relay_mobile_devices SET delivery_disabled_at=now() WHERE user_id=${input.userId}`;
            yield* sql`UPDATE relay_live_activities SET delivery_disabled_at=now() WHERE user_id=${input.userId}`;
          }
          yield* sql`INSERT INTO relay_account_access(user_id,subject_digest,status,account_epoch,deletion_requested_at) VALUES (${input.userId},${digest},${input.kind === "allow" ? "allowed" : "suspended"},${epoch},${input.kind === "delete" ? DateTime.formatIso(yield* DateTime.now) : null}) ON CONFLICT(subject_digest) DO UPDATE SET status=excluded.status,account_epoch=excluded.account_epoch,deletion_requested_at=excluded.deletion_requested_at,updated_at=now()`;
          return operation.id;
        }),
      )
      .pipe(Effect.mapError((e) => (e._tag === "SqlError" ? unavailable() : e)));
    return yield* getOperation(result);
  });
  const resume = Effect.fn("AccountLifecycle.resume")(function* (id: string) {
    const operation = yield* getOperation(id);
    if (operation.completed_at !== null) return operation;
    if (!operation.user_id) return yield* unavailable();
    const userId = operation.user_id;
    const lease = yield* crypto.randomUUIDv4().pipe(Effect.mapError(unavailable));
    const [claimed] = yield* sql<{
      claim_version: number;
    }>`UPDATE relay_account_operations SET state='running',lease_owner=${lease},lease_expires_at=now()+interval '60 seconds',claim_version=claim_version+1,attempts=attempts+1 WHERE id=${id} AND completed_at IS NULL AND (lease_expires_at IS NULL OR lease_expires_at<now()) RETURNING claim_version`.pipe(
      Effect.mapError(unavailable),
    );
    if (!claimed) return yield* getOperation(id);
    const outcome = yield* Effect.gen(function* () {
      const resources = yield* sql<{
        resource_id: string;
        endpoint_key: string;
      }>`SELECT resource_id,endpoint_key FROM relay_account_operation_resources WHERE operation_id=${id} AND resource_kind='hooks' AND outcome<>'done' ORDER BY resource_id LIMIT 20`;
      for (const resource of resources) {
        const [renewed] = yield* sql<{
          id: string;
        }>`UPDATE relay_account_operations SET lease_expires_at=now()+interval '60 seconds' WHERE id=${id} AND lease_owner=${lease} AND claim_version=${claimed.claim_version} AND lease_expires_at>now() RETURNING id`;
        if (!renewed) return;
        yield* inbox.clear({ endpointKey: resource.endpoint_key, retire: true });
        yield* sql`UPDATE relay_account_operation_resources SET outcome='done',updated_at=now() WHERE operation_id=${id} AND resource_kind='hooks' AND resource_id=${resource.resource_id} AND EXISTS(SELECT 1 FROM relay_account_operations WHERE id=${id} AND lease_owner=${lease} AND claim_version=${claimed.claim_version})`;
      }
      if (operation.kind === "delete")
        yield* erasure.closeCounters(userId, operation.subject_digest);
      yield* tx.run(
        { userIds: [userId] },
        Effect.gen(function* () {
          const [finished] = yield* sql<{
            id: string;
          }>`UPDATE relay_account_operations SET state='completed',completed_at=now(),updated_at=now(),step_state=${sql.json(operationProgress(operation.kind, true))},lease_owner=NULL,lease_expires_at=NULL WHERE id=${id} AND lease_owner=${lease} AND claim_version=${claimed.claim_version} AND NOT EXISTS(SELECT 1 FROM relay_account_operation_resources WHERE operation_id=${id} AND outcome<>'done') RETURNING id`;
          if (finished) {
            if (operation.kind === "delete")
              yield* erasure.purge(userId, operation.subject_digest, id);
            else
              yield* sql`DELETE FROM relay_environment_owners WHERE user_id=${userId} AND state='releasing'`;
          }
        }),
      );
    }).pipe(Effect.mapError(unavailable), Effect.result);
    if (outcome._tag === "Failure")
      yield* sql`UPDATE relay_account_operations SET state='pending',lease_owner=NULL,lease_expires_at=NULL,last_error_code='dependency_unavailable',next_attempt_at=now()+LEAST(300,30*power(2,LEAST(attempts-1,4)))*interval '1 second' WHERE id=${id} AND lease_owner=${lease} AND claim_version=${claimed.claim_version}`.pipe(
        Effect.mapError(unavailable),
      );
    yield* sql`UPDATE relay_account_operations SET state='pending',lease_owner=NULL,lease_expires_at=NULL,next_attempt_at=now() WHERE id=${id} AND lease_owner=${lease} AND claim_version=${claimed.claim_version} AND completed_at IS NULL`.pipe(
      Effect.mapError(unavailable),
    );
    return yield* getOperation(id);
  });
  const getDeletion = Effect.fn("AccountLifecycle.getDeletion")(function* (userId: string) {
    const digest = yield* subjectDigest(userId).pipe(
      Effect.provideService(RelayConfiguration, config),
    );
    const [access] = yield* sql<{
      status: string;
      relay_erased_at: string | null;
    }>`SELECT status,relay_erased_at::text AS relay_erased_at FROM relay_account_access WHERE subject_digest=${digest}`.pipe(
      Effect.mapError(unavailable),
    );
    const [op] =
      yield* sql<AccountOperation>`SELECT ${sql.literal(operationColumns)} FROM relay_account_operations WHERE subject_digest=${digest} AND kind='delete' AND (completed_at IS NULL OR completed_at > now()-interval '90 days') LIMIT 1`.pipe(
        Effect.mapError(unavailable),
      );
    if (!op)
      return access?.status === "deleted" && access.relay_erased_at
        ? { status: "deleted" as const, deletedAt: access.relay_erased_at }
        : { status: "absent" as const };
    const [hosts] = yield* sql<{
      pending: number;
    }>`SELECT count(DISTINCT target_digest)::int AS pending FROM relay_host_revocations WHERE subject_digest=${digest}`.pipe(
      Effect.mapError(unavailable),
    );
    return {
      status: "progress" as const,
      operationId: op.id,
      relayState: op.completed_at ? ("erased" as const) : ("erasing" as const),
      step: op.completed_at ? ("relay_erasure_completed" as const) : ("relay_denied" as const),
      relayDenied: true as const,
      hostCleanup: {
        pending: hosts?.pending ?? 0,
        acknowledged: op.host_acknowledged,
        unsupported: 0,
      },
      endpointCleanup: "pending" as const,
      identityAction: op.identity_deleted
        ? ("already_deleted" as const)
        : ("delete_clerk_user" as const),
      ...(op.completed_at ? {} : { retryAfterSeconds: 30 }),
      ...(op.last_error_code ? { lastErrorCode: op.last_error_code } : {}),
      traceId: "relay",
    };
  });
  const requestDelete = Effect.fn("AccountLifecycle.requestDelete")(function* (input: {
    userId: string;
    idempotencyKey: string;
    identityDeleted?: boolean;
  }) {
    const existing = yield* getDeletion(input.userId);
    if (existing.status === "deleted") return existing;
    const outcome = yield* request({ ...input, kind: "delete" }).pipe(Effect.result);
    if (outcome._tag === "Failure") {
      if (
        outcome.failure._tag === "AccountLifecycleConflict" &&
        outcome.failure.code === "account_deleted"
      ) {
        const terminal = yield* getDeletion(input.userId);
        if (terminal.status !== "absent") return terminal;
      }
      return yield* outcome.failure;
    }
    const op = outcome.success;
    if (input.identityDeleted)
      yield* sql`UPDATE relay_account_operations SET identity_deleted=1 WHERE id=${op.id}`.pipe(
        Effect.mapError(unavailable),
      );
    const result = yield* getDeletion(input.userId);
    if (result.status === "absent") return yield* unavailable();
    return result;
  });
  return AccountLifecycle.of({
    requestDelete,
    getDeletion,
    request,
    resume,
    getOperation,
    getAccount: Effect.fn("AccountLifecycle.getAccount")(function* (userId) {
      const digest = yield* subjectDigest(userId).pipe(
        Effect.provideService(RelayConfiguration, config),
      );
      const [access] = yield* sql<{
        status: string;
        account_epoch: number;
      }>`SELECT status,account_epoch FROM relay_account_access WHERE subject_digest=${digest}`;
      const operations =
        yield* sql<AccountOperation>`SELECT ${sql.literal(operationColumns)} FROM relay_account_operations WHERE subject_digest=${digest} ORDER BY created_at DESC LIMIT 20`;
      return {
        status: access?.status ?? "not_invited",
        accountEpoch: access?.account_epoch ?? null,
        operations,
      };
    }, Effect.mapError(unavailable)),
    scanPending: Effect.gen(function* () {
      yield* sql`DELETE FROM relay_account_operations WHERE kind='delete' AND completed_at<now()-interval '90 days' AND user_id IS NULL`.pipe(
        Effect.mapError(unavailable),
      );
      const due = yield* sql<{
        id: string;
      }>`SELECT id FROM relay_account_operations WHERE completed_at IS NULL AND next_attempt_at<=now() AND (lease_expires_at IS NULL OR lease_expires_at<now()) ORDER BY next_attempt_at LIMIT 20`.pipe(
        Effect.mapError(unavailable),
      );
      for (const op of due)
        yield* resume(op.id).pipe(
          Effect.tapError((e) =>
            Effect.logWarning("Account lifecycle resume failed", { errorTag: e._tag }),
          ),
          Effect.ignore,
        );
    }),
  });
});
export const layer = Layer.effect(AccountLifecycle, make);
