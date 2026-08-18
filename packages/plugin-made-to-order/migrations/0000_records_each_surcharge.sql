CREATE TABLE "made_to_order_surcharge" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cart_id" text NOT NULL,
	"variant_id" text NOT NULL,
	"requested_lead_time_days" integer NOT NULL,
	"standard_lead_time_days" integer NOT NULL,
	"amount" integer NOT NULL,
	"currency" text NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL
);
