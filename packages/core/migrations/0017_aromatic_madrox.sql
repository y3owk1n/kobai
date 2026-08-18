CREATE TABLE "core_idempotency_key" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"fingerprint" text NOT NULL,
	"order_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "core_idempotency_key_key_unique" UNIQUE("key")
);
--> statement-breakpoint
ALTER TABLE "core_idempotency_key" ADD CONSTRAINT "core_idempotency_key_order_id_core_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."core_order"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "core_idempotency_key_expires_idx" ON "core_idempotency_key" USING btree ("expires_at");