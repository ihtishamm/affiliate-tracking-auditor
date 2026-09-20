CREATE TABLE "run_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"status" text NOT NULL,
	"attempt" integer NOT NULL,
	"detail" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_traces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"trace" jsonb NOT NULL,
	"bytes" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idempotency_key" text NOT NULL,
	"url" text NOT NULL,
	"url_host" text NOT NULL,
	"click_id_param" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_traces" ADD CONSTRAINT "run_traces_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_events_run_id_created_at_idx" ON "run_events" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "run_traces_run_id_idx" ON "run_traces" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "run_traces_expires_at_idx" ON "run_traces" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_idempotency_key_idx" ON "runs" USING btree ("idempotency_key");