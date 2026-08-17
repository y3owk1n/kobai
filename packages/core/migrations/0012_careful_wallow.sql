CREATE TABLE "core_order" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" bigserial NOT NULL,
	"cart_id" uuid,
	"shopper_email" text,
	"shopper_external_id" text,
	"currency" text NOT NULL,
	"total" bigint NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "core_order_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "core_order_line_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"variant_id" uuid,
	"title" text NOT NULL,
	"sku" text NOT NULL,
	"unit_amount" bigint NOT NULL,
	"currency" text NOT NULL,
	"quantity" bigint NOT NULL,
	"tax" bigint DEFAULT 0 NOT NULL,
	"total" bigint NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "core_order_line_item_quantity_is_positive" CHECK ("core_order_line_item"."quantity" > 0)
);
--> statement-breakpoint
ALTER TABLE "core_order" ADD CONSTRAINT "core_order_cart_id_core_cart_id_fk" FOREIGN KEY ("cart_id") REFERENCES "public"."core_cart"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core_order_line_item" ADD CONSTRAINT "core_order_line_item_order_id_core_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."core_order"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core_order_line_item" ADD CONSTRAINT "core_order_line_item_variant_id_core_variant_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."core_variant"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "core_order_line_item_order_idx" ON "core_order_line_item" USING btree ("order_id");