ALTER TABLE "core_price" ADD COLUMN "region_id" uuid;--> statement-breakpoint
ALTER TABLE "core_price" ADD COLUMN "channel_id" uuid;--> statement-breakpoint
ALTER TABLE "core_price" ADD CONSTRAINT "core_price_region_id_core_region_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."core_region"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core_price" ADD CONSTRAINT "core_price_channel_id_core_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."core_channel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "core_price_region_idx" ON "core_price" USING btree ("region_id");--> statement-breakpoint
CREATE INDEX "core_price_channel_idx" ON "core_price" USING btree ("channel_id");