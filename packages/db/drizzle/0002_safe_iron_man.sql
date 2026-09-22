CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"funnel_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"previous_score" numeric(5, 4),
	"score" numeric(5, 4),
	"reasons" jsonb NOT NULL,
	"delivery_status" integer,
	"delivery_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "funnel_scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"funnel_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"score" numeric(5, 4),
	"statuses" jsonb NOT NULL,
	"counts" jsonb NOT NULL,
	"scored_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "funnels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"url" text NOT NULL,
	"url_host" text NOT NULL,
	"click_id_param" text NOT NULL,
	"label" text NOT NULL,
	"purchase_host" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "funnel_id" uuid;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_funnel_id_funnels_id_fk" FOREIGN KEY ("funnel_id") REFERENCES "public"."funnels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funnel_scores" ADD CONSTRAINT "funnel_scores_funnel_id_funnels_id_fk" FOREIGN KEY ("funnel_id") REFERENCES "public"."funnels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funnel_scores" ADD CONSTRAINT "funnel_scores_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_funnel_run_idx" ON "alerts" USING btree ("funnel_id","run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "funnel_scores_run_id_idx" ON "funnel_scores" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "funnel_scores_funnel_id_idx" ON "funnel_scores" USING btree ("funnel_id","scored_at");