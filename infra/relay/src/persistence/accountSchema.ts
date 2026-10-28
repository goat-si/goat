import type { AccountOperationProgress } from "../accounts/AccountOperationProgress.ts";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

const time = (name: string) => timestamp(name, { withTimezone: true, mode: "string" });

export const relayAccountAccess = pgTable(
  "relay_account_access",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subjectDigest: text("subject_digest").unique(),
    userId: varchar("user_id", { length: 255 }).unique(),
    deletionRequestedAt: time("deletion_requested_at"),
    relayErasedAt: time("relay_erased_at"),
    status: varchar("status", { length: 16 })
      .notNull()
      .$type<"allowed" | "suspended" | "deleted">(),
    accountEpoch: integer("account_epoch").notNull(),
    createdAt: time("created_at").notNull().defaultNow(),
    updatedAt: time("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check("relay_access_status", sql`${t.status} IN ('allowed','suspended','deleted')`),
    check(
      "relay_deleted_identity",
      sql`${t.status} <> 'deleted' OR (${t.subjectDigest} IS NOT NULL AND ${t.userId} IS NULL AND ${t.relayErasedAt} IS NOT NULL)`,
    ),
    check("relay_access_epoch", sql`${t.accountEpoch} >= 1`),
  ],
);

export const relayAccountOperations = pgTable(
  "relay_account_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subjectDigest: text("subject_digest"),
    userId: varchar("user_id", { length: 255 }),
    identityDeleted: integer("identity_deleted").notNull().default(0),
    hostAcknowledged: integer("host_acknowledged").notNull().default(0),
    kind: varchar("kind", { length: 16 }).notNull().$type<"suspend" | "allow" | "delete">(),
    accountEpoch: integer("account_epoch").notNull(),
    expectedEpoch: integer("expected_epoch").notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 255 }).notNull(),
    requestHash: text("request_hash").notNull(),
    state: varchar("state", { length: 16 })
      .notNull()
      .$type<"pending" | "running" | "completed" | "superseded">(),
    stepState: jsonb("step_state").notNull().$type<AccountOperationProgress>(),
    leaseOwner: uuid("lease_owner"),
    leaseExpiresAt: time("lease_expires_at"),
    claimVersion: integer("claim_version").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: time("next_attempt_at").notNull().defaultNow(),
    lastErrorCode: text("last_error_code"),
    createdAt: time("created_at").notNull().defaultNow(),
    updatedAt: time("updated_at").notNull().defaultNow(),
    completedAt: time("completed_at"),
  },
  (t) => [
    uniqueIndex("idx_relay_operation_idempotency").on(t.subjectDigest, t.idempotencyKey),
    uniqueIndex("idx_relay_operation_pending")
      .on(t.subjectDigest)
      .where(sql`${t.completedAt} IS NULL`),
    index("idx_relay_operation_due").on(t.nextAttemptAt, t.leaseExpiresAt),
    check("relay_operation_epochs", sql`${t.accountEpoch} >= 1 AND ${t.expectedEpoch} >= 0`),
    check("relay_operation_kind", sql`${t.kind} IN ('suspend','allow','delete')`),
    check(
      "relay_operation_state",
      sql`${t.state} IN ('pending','running','completed','superseded')`,
    ),
  ],
);

export const relayAccountOperationResources = pgTable(
  "relay_account_operation_resources",
  {
    operationId: uuid("operation_id")
      .notNull()
      .references(() => relayAccountOperations.id),
    resourceKind: varchar("resource_kind", { length: 32 }).notNull(),
    resourceId: text("resource_id").notNull(),
    ownerUserId: varchar("owner_user_id", { length: 255 }).notNull(),
    resourceEpoch: integer("resource_epoch"),
    environmentId: text("environment_id"),
    environmentPublicKey: text("environment_public_key"),
    allocationIncarnationId: uuid("allocation_incarnation_id"),
    capturedGeneration: integer("captured_generation"),
    endpointKey: text("endpoint_key"),
    outcome: varchar("outcome", { length: 16 }).notNull().default("pending"),
    resultCode: text("result_code"),
    updatedAt: time("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.operationId, t.resourceKind, t.resourceId] })],
);

export const relayEnvironmentOwners = pgTable(
  "relay_environment_owners",
  {
    environmentPublicKey: text("environment_public_key").primaryKey(),
    userId: varchar("user_id", { length: 255 }).notNull(),
    environmentId: text("environment_id").notNull(),
    accountEpoch: integer("account_epoch"),
    claimId: uuid("claim_id").notNull().defaultRandom(),
    state: varchar("state", { length: 16 }).notNull().$type<"pending" | "active" | "releasing">(),
    createdAt: time("created_at").notNull().defaultNow(),
    updatedAt: time("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("idx_relay_owner_claim").on(t.claimId),
    check("relay_owner_state", sql`${t.state} IN ('pending','active','releasing')`),
  ],
);

export const relayEndpointIdentities = pgTable(
  "relay_endpoint_identities",
  {
    stage: text("stage").notNull(),
    userId: varchar("user_id", { length: 255 }).notNull(),
    environmentId: text("environment_id").notNull(),
    highWaterGeneration: integer("high_water_generation").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.stage, t.userId, t.environmentId] }),
    check("relay_endpoint_generation", sql`${t.highWaterGeneration} BETWEEN 0 AND 2147483646`),
  ],
);

export const relayRetiredEndpoints = pgTable(
  "relay_retired_endpoints",
  {
    stage: text("stage").notNull(),
    subjectDigest: text("subject_digest"),
    userId: varchar("user_id", { length: 255 }),
    environmentId: text("environment_id"),
    generation: integer("generation").notNull(),
    endpointKey: text("endpoint_key").primaryKey(),
    tunnelName: text("tunnel_name").notNull(),
    hostname: text("hostname").notNull(),
    tunnelId: text("tunnel_id"),
    dnsRecordId: text("dns_record_id"),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("idx_relay_retired_key").on(t.endpointKey),
    uniqueIndex("idx_relay_retired_name").on(t.tunnelName),
    uniqueIndex("idx_relay_retired_hostname").on(t.hostname),
  ],
);

export const relayManagedProvisioningIntents = pgTable(
  "relay_managed_provisioning_intents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    attemptId: uuid("attempt_id").notNull().defaultRandom(),
    stage: text("stage").notNull(),
    endpointKey: text("endpoint_key").notNull(),
    userId: varchar("user_id", { length: 255 }).notNull(),
    environmentId: text("environment_id").notNull(),
    environmentPublicKey: text("environment_public_key").notNull(),
    accountEpoch: integer("account_epoch").notNull(),
    allocationIncarnationId: uuid("allocation_incarnation_id").notNull(),
    allocationGeneration: integer("allocation_generation").notNull(),
    tunnelName: text("tunnel_name").notNull(),
    tunnelId: text("tunnel_id"),
    state: varchar("state", { length: 16 })
      .notNull()
      .$type<"intent" | "created" | "recorded" | "abandoned">(),
    createdAt: time("created_at").notNull().defaultNow(),
    updatedAt: time("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("idx_relay_intent_attempt").on(t.attemptId),
    uniqueIndex("idx_relay_intent_unsettled")
      .on(t.stage, t.endpointKey)
      .where(sql`${t.state} IN ('intent','created')`),
    check("relay_intent_epoch", sql`${t.accountEpoch} >= 1`),
  ],
);

export const relayRetiredCollectorState = pgTable("relay_retired_collector_state", {
  stage: text("stage").primaryKey(),
  tunnelCycle: integer("tunnel_cycle").notNull().default(0),
  dnsCycle: integer("dns_cycle").notNull().default(0),
  tunnelPage: integer("tunnel_page").notNull().default(1),
  dnsPage: integer("dns_page").notNull().default(1),
  leaseOwner: uuid("lease_owner"),
  leaseExpiresAt: time("lease_expires_at"),
  observedBacklog: integer("observed_backlog").notNull().default(0),
});

export const relayRetiredInventoryBacklog = pgTable(
  "relay_retired_inventory_backlog",
  {
    stage: text("stage").notNull(),
    kind: varchar("kind", { length: 16 }).notNull(),
    resourceId: text("resource_id").notNull(),
    lastSeenCycle: integer("last_seen_cycle").notNull(),
  },
  (t) => [primaryKey({ columns: [t.stage, t.kind, t.resourceId] })],
);

export const relayAccountOperationRequests = pgTable(
  "relay_account_operation_requests",
  {
    userId: varchar("user_id", { length: 255 }).notNull(),
    subjectDigest: text("subject_digest"),
    idempotencyKey: varchar("idempotency_key", { length: 255 }).notNull(),
    operationId: uuid("operation_id")
      .notNull()
      .references(() => relayAccountOperations.id),
  },
  (t) => [primaryKey({ columns: [t.userId, t.idempotencyKey] })],
);

export const relayHostRevocations = pgTable(
  "relay_host_revocations",
  {
    id: text("id").primaryKey(),
    subjectDigest: text("subject_digest").notNull(),
    credentialDigest: text("credential_digest").notNull().unique(),
    targetDigest: text("target_digest").notNull(),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (t) => [index("idx_relay_revocation_subject_target").on(t.subjectDigest, t.targetDigest)],
);
