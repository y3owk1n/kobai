CREATE TABLE "core_api_key" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"token_hash" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "core_api_key_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "core_api_key_kind_is_known" CHECK ("core_api_key"."kind" in ('publishable', 'secret'))
);
