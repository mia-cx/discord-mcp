CREATE TABLE "voice_global_opt_outs" (
	"user_id" text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE "voice_opt_outs" (
	"bot_id" text NOT NULL,
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	CONSTRAINT "voice_opt_outs_bot_id_guild_id_user_id_pk" PRIMARY KEY("bot_id","guild_id","user_id")
);
