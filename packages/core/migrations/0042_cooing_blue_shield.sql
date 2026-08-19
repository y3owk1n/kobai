CREATE TABLE "core_product_option" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core_variant_option_value" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"variant_id" uuid NOT NULL,
	"option_id" uuid NOT NULL,
	"value" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core_product_option" ADD CONSTRAINT "core_product_option_product_id_core_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."core_product"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core_variant_option_value" ADD CONSTRAINT "core_variant_option_value_variant_id_core_variant_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."core_variant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core_variant_option_value" ADD CONSTRAINT "core_variant_option_value_option_id_core_product_option_id_fk" FOREIGN KEY ("option_id") REFERENCES "public"."core_product_option"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "core_product_option_product_position_idx" ON "core_product_option" USING btree ("product_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "core_variant_option_value_variant_option_idx" ON "core_variant_option_value" USING btree ("variant_id","option_id");