ALTER TABLE "workflow_revisions" ADD COLUMN "schedules" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "schedule_cursor" timestamp with time zone;