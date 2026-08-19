ALTER TABLE "core_product" ALTER COLUMN "handle" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "core_product" ADD CONSTRAINT "core_product_handle_unique" UNIQUE("handle");