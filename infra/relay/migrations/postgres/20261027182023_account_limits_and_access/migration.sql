DO $$
DECLARE conflicts text;
BEGIN
 SELECT string_agg(environment_public_key, ', ') INTO conflicts FROM
 (SELECT environment_public_key FROM relay_environment_links WHERE revoked_at IS NULL GROUP BY environment_public_key HAVING count(*) > 1) duplicate_keys;
 IF conflicts IS NOT NULL THEN RAISE EXCEPTION 'Resolve duplicate active environment keys before migration: %', conflicts; END IF;
 SELECT string_agg(user_id, ', ') INTO conflicts FROM relay_managed_tunnel_limits WHERE max_tunnels < 0;
 IF conflicts IS NOT NULL THEN RAISE EXCEPTION 'Resolve negative tunnel overrides before migration: %', conflicts; END IF;
 SELECT string_agg(user_id || '/' || environment_id, ', ') INTO conflicts FROM relay_managed_endpoint_allocations
 WHERE tunnel_name !~ '^goatrelay-managedendpoint-[a-z0-9-]+-[0-9a-f]{16}$' OR hostname = '' OR user_id = '' OR environment_id = '';
 IF conflicts IS NOT NULL THEN RAISE EXCEPTION 'Resolve malformed allocation identities before migration: %', conflicts; END IF;
END $$;
--> statement-breakpoint
CREATE TABLE "relay_account_access" (
	"user_id" varchar(255) PRIMARY KEY,
	"status" varchar(16) NOT NULL,
	"account_epoch" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "relay_access_status" CHECK ("status" IN ('allowed','suspended')),
	CONSTRAINT "relay_access_epoch" CHECK ("account_epoch" >= 1)
);
--> statement-breakpoint
CREATE TABLE "relay_account_operation_resources" (
	"operation_id" uuid,
	"resource_kind" varchar(32),
	"resource_id" text,
	"owner_user_id" varchar(255) NOT NULL,
	"resource_epoch" integer,
	"environment_id" text,
	"environment_public_key" text,
	"allocation_incarnation_id" uuid,
	"captured_generation" integer,
	"endpoint_key" text,
	"outcome" varchar(16) DEFAULT 'pending' NOT NULL,
	"result_code" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "relay_account_operation_resources_pkey" PRIMARY KEY("operation_id","resource_kind","resource_id")
);
--> statement-breakpoint
CREATE TABLE "relay_account_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" varchar(255) NOT NULL,
	"kind" varchar(16) NOT NULL,
	"account_epoch" integer NOT NULL,
	"expected_epoch" integer NOT NULL,
	"idempotency_key" varchar(255) NOT NULL,
	"request_hash" text NOT NULL,
	"state" varchar(16) NOT NULL,
	"step_state" jsonb NOT NULL,
	"lease_owner" uuid,
	"lease_expires_at" timestamp with time zone,
	"claim_version" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "relay_operation_epochs" CHECK ("account_epoch" >= 1 AND "expected_epoch" >= 0),
	CONSTRAINT "relay_operation_kind" CHECK ("kind" IN ('suspend','allow')),
	CONSTRAINT "relay_operation_state" CHECK ("state" IN ('pending','running','completed'))
);
--> statement-breakpoint
CREATE TABLE "relay_endpoint_identities" (
	"stage" text,
	"user_id" varchar(255),
	"environment_id" text,
	"high_water_generation" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "relay_endpoint_identities_pkey" PRIMARY KEY("stage","user_id","environment_id"),
	CONSTRAINT "relay_endpoint_generation" CHECK ("high_water_generation" BETWEEN 0 AND 2147483646)
);
--> statement-breakpoint
CREATE TABLE "relay_environment_owners" (
	"environment_public_key" text PRIMARY KEY,
	"user_id" varchar(255) NOT NULL,
	"environment_id" text NOT NULL,
	"account_epoch" integer,
	"claim_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"state" varchar(16) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "relay_owner_state" CHECK ("state" IN ('pending','active','releasing'))
);
--> statement-breakpoint
CREATE TABLE "relay_managed_provisioning_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"attempt_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"stage" text NOT NULL,
	"endpoint_key" text NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"environment_id" text NOT NULL,
	"environment_public_key" text NOT NULL,
	"account_epoch" integer NOT NULL,
	"allocation_incarnation_id" uuid NOT NULL,
	"allocation_generation" integer NOT NULL,
	"tunnel_name" text NOT NULL,
	"tunnel_id" text,
	"state" varchar(16) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "relay_intent_epoch" CHECK ("account_epoch" >= 1)
);
--> statement-breakpoint
CREATE TABLE "relay_retired_collector_state" (
	"stage" text PRIMARY KEY,
	"tunnel_page" integer DEFAULT 1 NOT NULL,
	"dns_page" integer DEFAULT 1 NOT NULL,
	"lease_owner" uuid,
	"lease_expires_at" timestamp with time zone,
	"observed_backlog" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relay_retired_endpoints" (
	"stage" text,
	"user_id" varchar(255),
	"environment_id" text,
	"generation" integer,
	"endpoint_key" text NOT NULL,
	"tunnel_name" text NOT NULL,
	"hostname" text NOT NULL,
	"tunnel_id" text,
	"dns_record_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "relay_retired_endpoints_pkey" PRIMARY KEY("stage","user_id","environment_id","generation")
);
--> statement-breakpoint
ALTER TABLE "relay_agent_activity_rows" ADD COLUMN "owner_user_id" varchar(255);--> statement-breakpoint
ALTER TABLE "relay_agent_activity_rows" ADD COLUMN "account_epoch" integer;--> statement-breakpoint
ALTER TABLE "relay_environment_credentials" ADD COLUMN "user_id" varchar(255);--> statement-breakpoint
ALTER TABLE "relay_environment_credentials" ADD COLUMN "account_epoch" integer;--> statement-breakpoint
ALTER TABLE "relay_environment_links" ADD COLUMN "account_epoch" integer;--> statement-breakpoint
ALTER TABLE "relay_live_activities" ADD COLUMN "delivery_disabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "relay_live_activities" ADD COLUMN "account_epoch" integer;--> statement-breakpoint
ALTER TABLE "relay_managed_endpoint_allocations" ADD COLUMN "incarnation_id" uuid DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "relay_managed_endpoint_allocations" ADD COLUMN "endpoint_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "relay_managed_endpoint_allocations" ADD COLUMN "capacity_released_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "relay_managed_endpoint_allocations" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "relay_managed_endpoint_allocations" ADD COLUMN "account_epoch" integer;--> statement-breakpoint
ALTER TABLE "relay_mobile_devices" ADD COLUMN "delivery_disabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "relay_mobile_devices" ADD COLUMN "account_epoch" integer;--> statement-breakpoint
ALTER TABLE "relay_managed_endpoint_allocations" DROP CONSTRAINT "relay_managed_endpoint_allocations_pkey";--> statement-breakpoint
ALTER TABLE "relay_managed_endpoint_allocations" ADD PRIMARY KEY ("incarnation_id");--> statement-breakpoint
ALTER TABLE "relay_environment_links" ALTER COLUMN "environment_label" SET DEFAULT 'GOAT Environment';--> statement-breakpoint
DROP INDEX "idx_relay_managed_endpoint_allocations_hostname";--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_managed_endpoint_allocations_hostname" ON "relay_managed_endpoint_allocations" ("hostname") WHERE "deleted_at" IS NULL;--> statement-breakpoint
DROP INDEX "idx_relay_managed_endpoint_allocations_tunnel_name";--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_managed_endpoint_allocations_tunnel_name" ON "relay_managed_endpoint_allocations" ("tunnel_name") WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_relay_credentials_owner_epoch" ON "relay_environment_credentials" ("user_id","account_epoch","revoked_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_links_active_key" ON "relay_environment_links" ("environment_public_key") WHERE "revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_allocations_live_owner" ON "relay_managed_endpoint_allocations" ("user_id","environment_id") WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_relay_allocations_capacity" ON "relay_managed_endpoint_allocations" ("user_id","capacity_released_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_operation_idempotency" ON "relay_account_operations" ("user_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_operation_pending" ON "relay_account_operations" ("user_id") WHERE "completed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_relay_operation_due" ON "relay_account_operations" ("next_attempt_at","lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_owner_claim" ON "relay_environment_owners" ("claim_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_intent_attempt" ON "relay_managed_provisioning_intents" ("attempt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_intent_unsettled" ON "relay_managed_provisioning_intents" ("stage","endpoint_key") WHERE "state" IN ('intent','created');--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_retired_key" ON "relay_retired_endpoints" ("endpoint_key");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_retired_name" ON "relay_retired_endpoints" ("tunnel_name");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_retired_hostname" ON "relay_retired_endpoints" ("hostname");--> statement-breakpoint
ALTER TABLE "relay_account_operation_resources" ADD CONSTRAINT "relay_account_operation_resources_89VWQzjMZlBq_fkey" FOREIGN KEY ("operation_id") REFERENCES "relay_account_operations"("id");--> statement-breakpoint
ALTER TABLE "relay_environment_credentials" ADD CONSTRAINT "relay_credentials_owner_epoch" CHECK (("user_id" IS NULL AND "account_epoch" IS NULL) OR ("user_id" IS NOT NULL AND "account_epoch" >= 1));--> statement-breakpoint
ALTER TABLE "relay_managed_tunnel_limits" ADD CONSTRAINT "relay_tunnel_limit_nonnegative" CHECK ("max_tunnels" >= 0);
--> statement-breakpoint
INSERT INTO relay_environment_owners(environment_public_key,user_id,environment_id,state)
 SELECT environment_public_key,user_id,environment_id,'active' FROM relay_environment_links WHERE revoked_at IS NULL;
--> statement-breakpoint
INSERT INTO relay_endpoint_identities(stage,user_id,environment_id,high_water_generation)
 SELECT substring(tunnel_name FROM '^goatrelay-managedendpoint-(.*)-[0-9a-f]{16}$'),user_id,environment_id,0 FROM relay_managed_endpoint_allocations;
