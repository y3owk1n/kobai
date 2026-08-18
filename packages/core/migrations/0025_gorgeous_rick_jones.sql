CREATE TABLE "core_fulfilment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"strategy" text NOT NULL,
	"requires_shipping" boolean NOT NULL,
	"tracks_inventory" boolean NOT NULL,
	"has_lead_time" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core_order_line_item" ADD COLUMN "fulfilment_id" uuid;--> statement-breakpoint
ALTER TABLE "core_fulfilment" ADD CONSTRAINT "core_fulfilment_order_id_core_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."core_order"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "core_fulfilment_order_idx" ON "core_fulfilment" USING btree ("order_id");--> statement-breakpoint
ALTER TABLE "core_order_line_item" ADD CONSTRAINT "core_order_line_item_fulfilment_id_core_fulfilment_id_fk" FOREIGN KEY ("fulfilment_id") REFERENCES "public"."core_fulfilment"("id") ON DELETE set null ON UPDATE no action;