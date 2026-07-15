-- Task #346: record which payment processor location created the
-- bowler's saved-customer record (paymentCustomerId / cardpointeProfileId).
-- Used by the account-deletion service to target exactly one processor
-- for saved-card cleanup instead of fanning out across every location
-- reachable through the bowler's leagues. NULL on legacy rows; the
-- deletion service falls back to the join-based scan in that case.
ALTER TABLE "bowlers" ADD COLUMN "payment_provider_location_id" integer;--> statement-breakpoint
ALTER TABLE "bowlers" ADD CONSTRAINT "bowlers_payment_provider_location_id_locations_id_fk" FOREIGN KEY ("payment_provider_location_id") REFERENCES "public"."locations"("id") ON DELETE set null ON UPDATE no action;
