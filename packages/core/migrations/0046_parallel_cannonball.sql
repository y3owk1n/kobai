CREATE TABLE "core_product_media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"media_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core_variant_media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"variant_id" uuid NOT NULL,
	"media_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core_product_media" ADD CONSTRAINT "core_product_media_product_id_core_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."core_product"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core_product_media" ADD CONSTRAINT "core_product_media_media_id_core_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."core_media"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core_variant_media" ADD CONSTRAINT "core_variant_media_variant_id_core_variant_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."core_variant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core_variant_media" ADD CONSTRAINT "core_variant_media_media_id_core_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."core_media"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "core_product_media_product_media_idx" ON "core_product_media" USING btree ("product_id","media_id");--> statement-breakpoint
CREATE INDEX "core_product_media_product_position_idx" ON "core_product_media" USING btree ("product_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "core_variant_media_variant_media_idx" ON "core_variant_media" USING btree ("variant_id","media_id");--> statement-breakpoint
CREATE INDEX "core_variant_media_variant_position_idx" ON "core_variant_media" USING btree ("variant_id","position");