ALTER TABLE "core_product" ALTER COLUMN "status" SET DEFAULT 'draft';--> statement-breakpoint
ALTER TABLE "core_product" ALTER COLUMN "status" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "core_product" ADD CONSTRAINT "core_product_status_is_known" CHECK ("core_product"."status" in ('draft', 'published', 'archived'));