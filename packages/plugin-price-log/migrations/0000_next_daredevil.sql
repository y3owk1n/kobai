CREATE TABLE "price_log_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"variant_id" text NOT NULL,
	"resolved_at" timestamp with time zone DEFAULT now() NOT NULL
);
