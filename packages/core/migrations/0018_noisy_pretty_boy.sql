CREATE TABLE "core_payment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"reference" text NOT NULL,
	"amount" bigint NOT NULL,
	"currency" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core_payment" ADD CONSTRAINT "core_payment_order_id_core_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."core_order"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "core_payment_order_idx" ON "core_payment" USING btree ("order_id");