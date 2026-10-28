CREATE TABLE "relay_host_revocations" (
	"id" text PRIMARY KEY,
	"subject_digest" text NOT NULL,
	"credential_digest" text NOT NULL UNIQUE,
	"target_digest" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "relay_delivery_attempts" ADD COLUMN "account_epoch" integer;--> statement-breakpoint
ALTER TABLE "relay_account_access" ADD COLUMN "id" uuid DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "relay_account_access" ADD COLUMN "subject_digest" text;--> statement-breakpoint
ALTER TABLE "relay_account_access" ADD COLUMN "deletion_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "relay_account_access" ADD COLUMN "relay_erased_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "relay_account_operation_requests" ADD COLUMN "subject_digest" text;--> statement-breakpoint
ALTER TABLE "relay_account_operations" ADD COLUMN "subject_digest" text;--> statement-breakpoint
ALTER TABLE "relay_account_operations" ADD COLUMN "identity_deleted" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "relay_account_operations" ADD COLUMN "host_acknowledged" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "relay_retired_endpoints" ADD COLUMN "subject_digest" text;--> statement-breakpoint
ALTER TABLE "relay_retired_endpoints" DROP CONSTRAINT "relay_retired_endpoints_pkey";--> statement-breakpoint
ALTER TABLE "relay_retired_endpoints" ADD PRIMARY KEY ("endpoint_key");--> statement-breakpoint
ALTER TABLE "relay_account_access" DROP CONSTRAINT "relay_account_access_pkey";--> statement-breakpoint
ALTER TABLE "relay_account_access" ADD PRIMARY KEY ("id");--> statement-breakpoint
ALTER TABLE "relay_account_access" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "relay_account_operations" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "relay_retired_endpoints" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "relay_retired_endpoints" ALTER COLUMN "environment_id" DROP NOT NULL;--> statement-breakpoint
DROP INDEX "idx_relay_operation_idempotency";--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_operation_idempotency" ON "relay_account_operations" ("subject_digest","idempotency_key");--> statement-breakpoint
DROP INDEX "idx_relay_operation_pending";--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_operation_pending" ON "relay_account_operations" ("subject_digest") WHERE "completed_at" IS NULL;--> statement-breakpoint
ALTER TABLE "relay_account_access" ADD CONSTRAINT "relay_account_access_subject_digest_key" UNIQUE("subject_digest");--> statement-breakpoint
ALTER TABLE "relay_account_access" ADD CONSTRAINT "relay_account_access_user_id_key" UNIQUE("user_id");--> statement-breakpoint
CREATE INDEX "idx_relay_delivery_attempts_owner_epoch" ON "relay_delivery_attempts" ("user_id","account_epoch");--> statement-breakpoint
CREATE INDEX "idx_relay_revocation_subject_target" ON "relay_host_revocations" ("subject_digest","target_digest");--> statement-breakpoint
ALTER TABLE "relay_account_access" ADD CONSTRAINT "relay_deleted_identity" CHECK ("status" <> 'deleted' OR ("subject_digest" IS NOT NULL AND "user_id" IS NULL AND "relay_erased_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "relay_account_access" DROP CONSTRAINT "relay_access_status", ADD CONSTRAINT "relay_access_status" CHECK ("status" IN ('allowed','suspended','deleted'));--> statement-breakpoint
ALTER TABLE "relay_account_operations" DROP CONSTRAINT "relay_operation_kind", ADD CONSTRAINT "relay_operation_kind" CHECK ("kind" IN ('suspend','allow','delete'));--> statement-breakpoint
ALTER TABLE "relay_account_operations" DROP CONSTRAINT "relay_operation_state", ADD CONSTRAINT "relay_operation_state" CHECK ("state" IN ('pending','running','completed','superseded'));