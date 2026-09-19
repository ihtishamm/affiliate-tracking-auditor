CREATE TABLE "conversion_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" text NOT NULL,
	"kind" text NOT NULL,
	"attempt" integer NOT NULL,
	"event_id" text NOT NULL,
	"target_host" text NOT NULL,
	"status_code" integer,
	"ok" boolean NOT NULL,
	"error" text,
	"pii_hashed" boolean,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "postback_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"postback_id" text NOT NULL,
	"click_id" text NOT NULL,
	"order_id" text NOT NULL,
	"status" text NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"currency" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"break_toggles" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shopify_webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" text NOT NULL,
	"topic" text NOT NULL,
	"shop_domain" text NOT NULL,
	"order_id" text NOT NULL,
	"order_name" text NOT NULL,
	"total_price" numeric(12, 2) NOT NULL,
	"currency" text NOT NULL,
	"attribution" jsonb NOT NULL,
	"order_created_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "postback_events_postback_id_idx" ON "postback_events" USING btree ("postback_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shopify_webhook_events_event_id_idx" ON "shopify_webhook_events" USING btree ("event_id");