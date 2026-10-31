CREATE TABLE "workflow_changes" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "workflow_changes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"bot_id" text NOT NULL,
	"workflow_name" text NOT NULL,
	"action" text NOT NULL,
	"revision" integer,
	"actor_id" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_revisions" (
	"workflow_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"source" text NOT NULL,
	"grants" jsonb NOT NULL,
	"events" jsonb NOT NULL,
	"intents" integer NOT NULL,
	"published_by" text NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_revisions_workflow_id_revision_pk" PRIMARY KEY("workflow_id","revision")
);
--> statement-breakpoint
CREATE TABLE "workflows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bot_id" text NOT NULL,
	"name" text NOT NULL,
	"latest_revision" integer NOT NULL,
	"enabled_revision" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflows_bot_id_name_unique" UNIQUE("bot_id","name")
);
--> statement-breakpoint
ALTER TABLE "workflow_revisions" ADD CONSTRAINT "workflow_revisions_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workflow_changes_bot_id_id_index" ON "workflow_changes" USING btree ("bot_id","id");