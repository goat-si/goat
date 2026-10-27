ALTER TABLE "relay_connect_link_reservations" ADD COLUMN "attempt_id" varchar(64);
ALTER TABLE "relay_managed_endpoint_allocations" ADD COLUMN IF NOT EXISTS "incarnation_id" uuid DEFAULT gen_random_uuid() NOT NULL;
