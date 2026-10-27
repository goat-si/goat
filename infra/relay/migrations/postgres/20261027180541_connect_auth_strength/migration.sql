CREATE TABLE "relay_client_keys" (
	"user_id" varchar(255),
	"client_id" varchar(64),
	"thumbprint" varchar(191),
	"admitted_at" integer NOT NULL,
	"policy_version" integer NOT NULL,
	"auth_generation" integer NOT NULL,
	"revoked_at" integer,
	CONSTRAINT "relay_client_keys_pkey" PRIMARY KEY("user_id","client_id","thumbprint")
);
--> statement-breakpoint
ALTER TABLE "relay_environment_links" ADD COLUMN "connect_auth_policy_version" integer;
ALTER TABLE "relay_client_keys" ADD COLUMN "admission_id" varchar(64);
CREATE TABLE "relay_connect_accounts" (
	"user_id" varchar(255) PRIMARY KEY,
	"generation" integer NOT NULL,
	"status" varchar(32) NOT NULL
);
