CREATE TABLE "relay_account_operation_requests" (
	"user_id" varchar(255),
	"idempotency_key" varchar(255),
	"operation_id" uuid NOT NULL,
	CONSTRAINT "relay_account_operation_requests_pkey" PRIMARY KEY("user_id","idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "relay_account_operation_requests" ADD CONSTRAINT "relay_account_operation_requests_bMG3SHA3I47z_fkey" FOREIGN KEY ("operation_id") REFERENCES "relay_account_operations"("id");