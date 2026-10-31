CREATE TABLE "shard_sessions" (
	"bot_id" text NOT NULL,
	"shard_id" integer NOT NULL,
	"sealed_session" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shard_sessions_bot_id_shard_id_pk" PRIMARY KEY("bot_id","shard_id")
);
--> statement-breakpoint
ALTER TABLE "shard_sessions" ADD CONSTRAINT "shard_sessions_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;