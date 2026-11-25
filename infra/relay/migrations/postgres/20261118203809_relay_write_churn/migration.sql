-- Pruning a few minutes of proofs scans the table anyway, but every DPoP proof insert maintained this index.
DROP INDEX IF EXISTS "idx_relay_dpop_proofs_expires_at";--> statement-breakpoint
-- Each attempt is inserted, then completed moments later. Page headroom lets the completion,
-- which only touches unindexed columns, stay a HOT update instead of writing every index on the table.
-- Applies only to pages written from now on, and pages already full keep their layout.
ALTER TABLE "relay_delivery_attempts" SET (fillfactor = 80);
