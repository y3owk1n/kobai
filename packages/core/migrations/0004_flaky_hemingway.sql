CREATE TABLE "core_price" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"variant_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"currency" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "core_price_amount_is_not_negative" CHECK ("core_price"."amount" >= 0),
	CONSTRAINT "core_price_currency_is_iso4217" CHECK (char_length("core_price"."currency") = 3)
);
--> statement-breakpoint
CREATE TABLE "core_product" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core_variant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "core_variant_sku_unique" UNIQUE("sku")
);
--> statement-breakpoint
ALTER TABLE "core_price" ADD CONSTRAINT "core_price_variant_id_core_variant_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."core_variant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core_variant" ADD CONSTRAINT "core_variant_product_id_core_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."core_product"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "core_price_variant_idx" ON "core_price" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX "core_variant_product_idx" ON "core_variant" USING btree ("product_id");