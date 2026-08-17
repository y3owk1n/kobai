CREATE TABLE "reviews_review" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"variant_id" uuid NOT NULL,
	"rating" integer NOT NULL,
	"body" text
);
