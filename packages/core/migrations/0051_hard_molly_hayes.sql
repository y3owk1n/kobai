CREATE TABLE "core_channel" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core_region" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"currency" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core_store_currency" (
	"code" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "core_store_currency_code_is_iso4217" CHECK (char_length("core_store_currency"."code") = 3)
);
--> statement-breakpoint
ALTER TABLE "core_api_key" ADD COLUMN "channel_id" uuid;--> statement-breakpoint
ALTER TABLE "core_store" ADD COLUMN "default_region_id" uuid;--> statement-breakpoint
ALTER TABLE "core_region" ADD CONSTRAINT "core_region_currency_core_store_currency_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."core_store_currency"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "core_channel_created_at_id_idx" ON "core_channel" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "core_region_created_at_id_idx" ON "core_region" USING btree ("created_at","id");--> statement-breakpoint
ALTER TABLE "core_api_key" ADD CONSTRAINT "core_api_key_channel_id_core_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."core_channel"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core_store" ADD CONSTRAINT "core_store_default_region_id_core_region_id_fk" FOREIGN KEY ("default_region_id") REFERENCES "public"."core_region"("id") ON DELETE restrict ON UPDATE no action;