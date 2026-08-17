CREATE TABLE "core_product" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core_variant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"sku" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core_variant" ADD CONSTRAINT "core_variant_product_id_core_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."core_product"("id") ON DELETE no action ON UPDATE no action;