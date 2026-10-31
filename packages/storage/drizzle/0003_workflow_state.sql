CREATE TABLE "workflow_kv" (
	"workflow_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_kv_workflow_id_key_pk" PRIMARY KEY("workflow_id","key")
);
--> statement-breakpoint
CREATE TABLE "workflow_runs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "workflow_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workflow_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"event" text NOT NULL,
	"outcome" text NOT NULL,
	"error" text,
	"logs" jsonb NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workflow_kv" ADD CONSTRAINT "workflow_kv_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workflow_runs_workflow_id_id_index" ON "workflow_runs" USING btree ("workflow_id","id");--> statement-breakpoint
CREATE INDEX "workflow_runs_finished_at_index" ON "workflow_runs" USING btree ("finished_at");