CREATE TABLE "core_collection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core_product_collection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"collection_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core_product_collection" ADD CONSTRAINT "core_product_collection_product_id_core_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."core_product"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core_product_collection" ADD CONSTRAINT "core_product_collection_collection_id_core_collection_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."core_collection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "core_collection_created_at_id_idx" ON "core_collection" USING btree ("created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "core_product_collection_product_collection_idx" ON "core_product_collection" USING btree ("product_id","collection_id");--> statement-breakpoint
CREATE INDEX "core_product_collection_collection_idx" ON "core_product_collection" USING btree ("collection_id");