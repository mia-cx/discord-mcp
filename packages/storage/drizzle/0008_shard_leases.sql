CREATE TABLE "leases" (
	"name" text PRIMARY KEY NOT NULL,
	"holder" text NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "shard_count" integer;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "gateway_url" text;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "online_until" bigint;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "rejected_code" integer;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "presence" text;