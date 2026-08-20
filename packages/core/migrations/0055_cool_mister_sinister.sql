ALTER TABLE "core_cart" ADD COLUMN "currency" text;--> statement-breakpoint
ALTER TABLE "core_cart" ADD COLUMN "region_id" uuid;--> statement-breakpoint
ALTER TABLE "core_cart" ADD CONSTRAINT "core_cart_region_id_core_region_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."core_region"("id") ON DELETE set null ON UPDATE no action;