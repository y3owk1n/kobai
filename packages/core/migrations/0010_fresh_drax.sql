CREATE TABLE "core_cart" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"shopper_email" text,
	"shopper_external_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core_cart_line_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cart_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"quantity" bigint NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "core_cart_line_item_quantity_is_positive" CHECK ("core_cart_line_item"."quantity" > 0)
);
--> statement-breakpoint
ALTER TABLE "core_cart_line_item" ADD CONSTRAINT "core_cart_line_item_cart_id_core_cart_id_fk" FOREIGN KEY ("cart_id") REFERENCES "public"."core_cart"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core_cart_line_item" ADD CONSTRAINT "core_cart_line_item_variant_id_core_variant_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."core_variant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "core_cart_line_item_cart_variant_idx" ON "core_cart_line_item" USING btree ("cart_id","variant_id");