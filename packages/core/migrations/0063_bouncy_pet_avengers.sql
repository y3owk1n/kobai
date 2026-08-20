CREATE TABLE "core_shipping_method" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"region_id" uuid NOT NULL,
	"name" text NOT NULL,
	"amount" bigint NOT NULL,
	"position" bigint NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "core_shipping_method_amount_is_not_negative" CHECK ("core_shipping_method"."amount" >= 0)
);
--> statement-breakpoint
ALTER TABLE "core_cart" ADD COLUMN "shipping_method_id" uuid;--> statement-breakpoint
ALTER TABLE "core_shipping_method" ADD CONSTRAINT "core_shipping_method_region_id_core_region_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."core_region"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "core_shipping_method_region_idx" ON "core_shipping_method" USING btree ("region_id");--> statement-breakpoint
ALTER TABLE "core_cart" ADD CONSTRAINT "core_cart_shipping_method_id_core_shipping_method_id_fk" FOREIGN KEY ("shipping_method_id") REFERENCES "public"."core_shipping_method"("id") ON DELETE set null ON UPDATE no action;