CREATE TABLE "core_order_adjustment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"order_line_item_id" uuid,
	"position" bigint NOT NULL,
	"code" text NOT NULL,
	"description" text NOT NULL,
	"amount" bigint NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core_order_adjustment" ADD CONSTRAINT "core_order_adjustment_order_id_core_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."core_order"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core_order_adjustment" ADD CONSTRAINT "core_order_adjustment_order_line_item_id_core_order_line_item_id_fk" FOREIGN KEY ("order_line_item_id") REFERENCES "public"."core_order_line_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "core_order_adjustment_order_idx" ON "core_order_adjustment" USING btree ("order_id");