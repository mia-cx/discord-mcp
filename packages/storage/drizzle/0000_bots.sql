CREATE TABLE "bots" (
	"id" text PRIMARY KEY NOT NULL,
	"sealed_token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
