CREATE TABLE "core_address" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"country" text NOT NULL,
	"lines" text[] NOT NULL,
	"postal_code" text,
	"region_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "core_address_country_is_iso3166" CHECK (char_length("core_address"."country") = 2),
	CONSTRAINT "core_address_has_a_line" CHECK (cardinality("core_address"."lines") > 0)
);
--> statement-breakpoint
CREATE TABLE "core_order_address" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"country" text NOT NULL,
	"lines" text[] NOT NULL,
	"postal_code" text,
	"region_id" uuid,
	"region_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "core_order_address_country_is_iso3166" CHECK (char_length("core_order_address"."country") = 2),
	CONSTRAINT "core_order_address_has_a_line" CHECK (cardinality("core_order_address"."lines") > 0)
);
--> statement-breakpoint
ALTER TABLE "core_cart" ADD COLUMN "address_id" uuid;--> statement-breakpoint
ALTER TABLE "core_address" ADD CONSTRAINT "core_address_region_id_core_region_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."core_region"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core_order_address" ADD CONSTRAINT "core_order_address_order_id_core_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."core_order"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core_order_address" ADD CONSTRAINT "core_order_address_region_id_core_region_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."core_region"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "core_address_region_idx" ON "core_address" USING btree ("region_id");--> statement-breakpoint
CREATE UNIQUE INDEX "core_order_address_order_idx" ON "core_order_address" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "core_order_address_region_idx" ON "core_order_address" USING btree ("region_id");--> statement-breakpoint
ALTER TABLE "core_cart" ADD CONSTRAINT "core_cart_address_id_core_address_id_fk" FOREIGN KEY ("address_id") REFERENCES "public"."core_address"("id") ON DELETE set null ON UPDATE no action;