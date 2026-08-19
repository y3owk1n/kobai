CREATE TABLE "stripe_unplaced_refund" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cart_id" text NOT NULL,
	"payment_intent_id" text NOT NULL,
	"refund_id" text NOT NULL,
	"amount" integer NOT NULL,
	"currency" text NOT NULL,
	"refusal" text NOT NULL,
	"refunded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stripe_unplaced_refund_payment_intent_id_unique" UNIQUE("payment_intent_id")
);
