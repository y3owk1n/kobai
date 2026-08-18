CREATE INDEX "core_api_key_created_at_id_idx" ON "core_api_key" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "core_order_created_at_id_idx" ON "core_order" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "core_product_created_at_id_idx" ON "core_product" USING btree ("created_at","id");