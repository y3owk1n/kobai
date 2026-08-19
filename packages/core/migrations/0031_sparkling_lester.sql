ALTER TABLE "core_reservation" ADD COLUMN "cart_id" uuid;--> statement-breakpoint
ALTER TABLE "core_reservation" ADD CONSTRAINT "core_reservation_cart_id_core_cart_id_fk" FOREIGN KEY ("cart_id") REFERENCES "public"."core_cart"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "core_reservation_cart_idx" ON "core_reservation" USING btree ("cart_id");