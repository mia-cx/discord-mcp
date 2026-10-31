ALTER TABLE "workflow_revisions" ADD COLUMN "bundle" text;--> statement-breakpoint
ALTER TABLE "workflow_revisions" ADD COLUMN "packages" jsonb DEFAULT '[]'::jsonb NOT NULL;