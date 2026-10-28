CREATE TABLE "relay_retired_inventory_backlog" (
	"stage" text,
	"kind" varchar(16),
	"resource_id" text,
	"last_seen_cycle" integer NOT NULL,
	CONSTRAINT "relay_retired_inventory_backlog_pkey" PRIMARY KEY("stage","kind","resource_id")
);
--> statement-breakpoint
ALTER TABLE "relay_retired_collector_state" ADD COLUMN "tunnel_cycle" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "relay_retired_collector_state" ADD COLUMN "dns_cycle" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "relay_agent_activity_rows" ADD CONSTRAINT "relayAgentActivityRows_epoch" CHECK ("account_epoch" IS NULL OR "account_epoch" >= 1);--> statement-breakpoint
ALTER TABLE "relay_environment_links" ADD CONSTRAINT "relayEnvironmentLinks_epoch" CHECK ("account_epoch" IS NULL OR "account_epoch" >= 1);--> statement-breakpoint
ALTER TABLE "relay_live_activities" ADD CONSTRAINT "relayLiveActivities_epoch" CHECK ("account_epoch" IS NULL OR "account_epoch" >= 1);--> statement-breakpoint
ALTER TABLE "relay_managed_endpoint_allocations" ADD CONSTRAINT "relayManagedEndpointAllocations_epoch" CHECK ("account_epoch" IS NULL OR "account_epoch" >= 1);--> statement-breakpoint
ALTER TABLE "relay_mobile_devices" ADD CONSTRAINT "relayMobileDevices_epoch" CHECK ("account_epoch" IS NULL OR "account_epoch" >= 1);--> statement-breakpoint
ALTER TABLE "relay_environment_credentials" DROP CONSTRAINT "relay_credentials_owner_epoch", ADD CONSTRAINT "relay_credentials_owner_epoch" CHECK (("user_id" IS NULL AND "account_epoch" IS NULL) OR ("user_id" IS NOT NULL AND "account_epoch" IS NOT NULL AND "account_epoch" >= 1));