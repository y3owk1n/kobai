CREATE TABLE "core_inventory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"variant_id" uuid NOT NULL,
	"on_hand" bigint DEFAULT 0 NOT NULL,
	"reserved" bigint DEFAULT 0 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "core_inventory_variant_id_unique" UNIQUE("variant_id"),
	CONSTRAINT "core_inventory_on_hand_is_not_negative" CHECK ("core_inventory"."on_hand" >= 0),
	CONSTRAINT "core_inventory_reserved_is_not_negative" CHECK ("core_inventory"."reserved" >= 0),
	CONSTRAINT "core_inventory_reserved_within_stock" CHECK ("core_inventory"."reserved" <= "core_inventory"."on_hand")
);
--> statement-breakpoint
CREATE TABLE "core_reservation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"subject" text NOT NULL,
	"quantity" bigint NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"order_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "core_reservation_quantity_is_positive" CHECK ("core_reservation"."quantity" > 0)
);
--> statement-breakpoint
ALTER TABLE "core_inventory" ADD CONSTRAINT "core_inventory_variant_id_core_variant_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."core_variant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core_reservation" ADD CONSTRAINT "core_reservation_order_id_core_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."core_order"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "core_reservation_expires_idx" ON "core_reservation" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "core_reservation_order_idx" ON "core_reservation" USING btree ("order_id");