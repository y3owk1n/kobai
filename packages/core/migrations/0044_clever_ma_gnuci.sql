CREATE TABLE "core_media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"storage_key" text NOT NULL,
	"content_type" text NOT NULL,
	"filename" text NOT NULL,
	"byte_size" integer NOT NULL,
	"width" integer,
	"height" integer,
	"alt" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "core_media_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
CREATE INDEX "core_media_created_at_id_idx" ON "core_media" USING btree ("created_at","id");