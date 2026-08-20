ALTER TABLE "core_fulfilment" ADD COLUMN "state" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "core_fulfilment" ADD COLUMN "tracking_reference" text;--> statement-breakpoint
ALTER TABLE "core_fulfilment" ADD CONSTRAINT "core_fulfilment_state_is_known" CHECK ("core_fulfilment"."state" in ('pending', 'dispatched', 'delivered', 'cancelled'));