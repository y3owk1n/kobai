CREATE TABLE "core_store" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"name" text NOT NULL,
	"default_currency" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "core_store_is_singleton" CHECK ("core_store"."singleton"),
	CONSTRAINT "core_store_currency_is_iso4217" CHECK (char_length("core_store"."default_currency") = 3)
);
