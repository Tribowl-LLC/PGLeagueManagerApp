CREATE TABLE "payment_allocation_funding_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"allocation_id" uuid NOT NULL,
	"payment_id" integer NOT NULL,
	"credited_bowler_id" integer NOT NULL,
	"generic_funding_id" uuid,
	"rotating_funding_id" uuid,
	"source_amount_minor" integer NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"obligation_id" uuid NOT NULL,
	"responsibility_id" uuid NOT NULL,
	"occurrence_id" uuid NOT NULL,
	"team_id" integer NOT NULL,
	"target_kind" text NOT NULL,
	"target_payer_bowler_id" integer,
	"assignment_id" uuid,
	"applied_by_user_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pay_alloc_fund_apps_identity_check" CHECK ("payment_allocation_funding_applications"."target_kind" IN ('bowler_responsibility', 'legacy_team_assignment') AND "payment_allocation_funding_applications"."amount_minor" > 0 AND "payment_allocation_funding_applications"."source_amount_minor" >= "payment_allocation_funding_applications"."amount_minor" AND "payment_allocation_funding_applications"."currency" = 'USD' AND (("payment_allocation_funding_applications"."generic_funding_id" IS NOT NULL AND "payment_allocation_funding_applications"."rotating_funding_id" IS NULL) OR ("payment_allocation_funding_applications"."generic_funding_id" IS NULL AND "payment_allocation_funding_applications"."rotating_funding_id" IS NOT NULL)) AND (("payment_allocation_funding_applications"."target_kind" = 'bowler_responsibility' AND "payment_allocation_funding_applications"."target_payer_bowler_id" IS NOT NULL AND "payment_allocation_funding_applications"."assignment_id" IS NULL) OR ("payment_allocation_funding_applications"."target_kind" = 'legacy_team_assignment' AND "payment_allocation_funding_applications"."target_payer_bowler_id" IS NULL AND "payment_allocation_funding_applications"."assignment_id" IS NOT NULL)))
);
--> statement-breakpoint
CREATE TABLE "weekly_payment_allocation_releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"funding_application_id" uuid NOT NULL,
	"payment_id" integer NOT NULL,
	"credited_bowler_id" integer NOT NULL,
	"source_allocation_id" uuid NOT NULL,
	"source_obligation_id" uuid NOT NULL,
	"source_application_amount_minor" integer NOT NULL,
	"replacement_allocation_id" uuid,
	"released_amount_minor" integer NOT NULL,
	"retained_amount_minor" integer DEFAULT 0 NOT NULL,
	"currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"reason" text NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"recorded_by_user_id" integer NOT NULL,
	"transaction_id" text DEFAULT pg_current_xact_id()::text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "weekly_payment_allocation_releases_amount_check" CHECK ("weekly_payment_allocation_releases"."released_amount_minor" > 0 AND "weekly_payment_allocation_releases"."retained_amount_minor" >= 0 AND "weekly_payment_allocation_releases"."released_amount_minor" + "weekly_payment_allocation_releases"."retained_amount_minor" = "weekly_payment_allocation_releases"."source_application_amount_minor" AND "weekly_payment_allocation_releases"."currency" = 'USD' AND (("weekly_payment_allocation_releases"."retained_amount_minor" = 0 AND "weekly_payment_allocation_releases"."replacement_allocation_id" IS NULL) OR ("weekly_payment_allocation_releases"."retained_amount_minor" > 0 AND "weekly_payment_allocation_releases"."replacement_allocation_id" IS NOT NULL))),
	CONSTRAINT "weekly_payment_allocation_releases_evidence_check" CHECK ("weekly_payment_allocation_releases"."reason" IN ('worksheet_correction', 'ledger_adoption') AND "weekly_payment_allocation_releases"."idempotency_key" ~ '^[A-Za-z0-9_-]{16,128}$' AND "weekly_payment_allocation_releases"."transaction_id" ~ '^[0-9]+$')
);
--> statement-breakpoint
CREATE TABLE "weekly_payment_funding_authorization_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"funding_id" uuid NOT NULL,
	"payment_id" integer NOT NULL,
	"credited_bowler_id" integer NOT NULL,
	"source_operation_id" uuid NOT NULL,
	"source_allocation_index" integer NOT NULL,
	"authorized_amount_minor" integer NOT NULL,
	"source_snapshot_fingerprint" varchar(96) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "weekly_payment_funding_auth_items_amount_check" CHECK ("weekly_payment_funding_authorization_items"."source_allocation_index" >= 0 AND "weekly_payment_funding_authorization_items"."authorized_amount_minor" > 0 AND "weekly_payment_funding_authorization_items"."source_snapshot_fingerprint" ~ '^lv(?:partnerexec:v3|rosterexec:v1|standingcutoff:v1):[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "weekly_payment_fundings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"credited_bowler_id" integer NOT NULL,
	"payment_id" integer NOT NULL,
	"portion_index" integer NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"source" text NOT NULL,
	"authorization_kind" text NOT NULL,
	"authorization_operation_id" uuid,
	"authorization_item_count" integer DEFAULT 0 NOT NULL,
	"authorization_fingerprint" varchar(96) NOT NULL,
	"adoption_id" uuid,
	"provenance_fingerprint" varchar(96) NOT NULL,
	"recorded_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "weekly_payment_fundings_amount_check" CHECK ("weekly_payment_fundings"."amount_minor" > 0 AND "weekly_payment_fundings"."portion_index" >= 0 AND "weekly_payment_fundings"."authorization_item_count" >= 0 AND "weekly_payment_fundings"."currency" = 'USD'),
	CONSTRAINT "weekly_payment_fundings_source_check" CHECK ("weekly_payment_fundings"."source" IN ('worksheet_manual', 'provider', 'legacy_adoption') AND "weekly_payment_fundings"."authorization_kind" IN ('manual_receipt', 'provider_snapshot', 'legacy_payment', 'legacy_provider_snapshot') AND (("weekly_payment_fundings"."source" = 'legacy_adoption' AND "weekly_payment_fundings"."adoption_id" IS NOT NULL AND "weekly_payment_fundings"."authorization_kind" IN ('legacy_payment', 'legacy_provider_snapshot')) OR ("weekly_payment_fundings"."source" <> 'legacy_adoption' AND "weekly_payment_fundings"."adoption_id" IS NULL AND (("weekly_payment_fundings"."source" = 'worksheet_manual' AND "weekly_payment_fundings"."authorization_kind" = 'manual_receipt') OR ("weekly_payment_fundings"."source" = 'provider' AND "weekly_payment_fundings"."authorization_kind" = 'provider_snapshot')))) AND (("weekly_payment_fundings"."authorization_kind" = 'provider_snapshot' AND "weekly_payment_fundings"."authorization_operation_id" IS NOT NULL AND "weekly_payment_fundings"."authorization_item_count" = 0) OR ("weekly_payment_fundings"."authorization_kind" = 'legacy_provider_snapshot' AND "weekly_payment_fundings"."authorization_operation_id" IS NOT NULL AND "weekly_payment_fundings"."authorization_item_count" > 0) OR ("weekly_payment_fundings"."authorization_kind" IN ('manual_receipt', 'legacy_payment') AND "weekly_payment_fundings"."authorization_operation_id" IS NULL AND "weekly_payment_fundings"."authorization_item_count" = 0))),
	CONSTRAINT "weekly_payment_fundings_auth_fp_check" CHECK ("weekly_payment_fundings"."authorization_fingerprint" ~ '^lv(?:accountfunding:v4|partnerexec:v3|rosterexec:v1|standingcutoff:v1|weeklyreceipt:v1|weeklyadopt:v1):[0-9a-f]{64}$'),
	CONSTRAINT "weekly_payment_fundings_fingerprint_check" CHECK ("weekly_payment_fundings"."provenance_fingerprint" ~ '^lvweeklyfund:v1:[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "weekly_payment_ledger_adoption_allocation_proof_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"proof_id" uuid NOT NULL,
	"step_index" integer NOT NULL,
	"correction_id" uuid NOT NULL,
	"payment_id" integer NOT NULL,
	"source_allocation_id" uuid NOT NULL,
	"replacement_allocation_id" uuid NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "weekly_payment_adopt_steps_check" CHECK ("weekly_payment_ledger_adoption_allocation_proof_steps"."step_index" >= 0 AND "weekly_payment_ledger_adoption_allocation_proof_steps"."amount_minor" > 0 AND "weekly_payment_ledger_adoption_allocation_proof_steps"."currency" = 'USD')
);
--> statement-breakpoint
CREATE TABLE "weekly_payment_ledger_adoption_allocation_proofs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"adoption_id" uuid NOT NULL,
	"funding_application_id" uuid,
	"rotating_application_id" uuid,
	"payment_id" integer NOT NULL,
	"credited_bowler_id" integer NOT NULL,
	"allocation_id" uuid NOT NULL,
	"original_allocation_id" uuid NOT NULL,
	"obligation_id" uuid NOT NULL,
	"obligation_owner_kind" text NOT NULL,
	"obligation_owner_bowler_id" integer,
	"obligation_owner_team_id" integer,
	"amount_minor" integer NOT NULL,
	"currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"correction_count" integer DEFAULT 0 NOT NULL,
	"correction_lineage_fingerprint" varchar(96) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "weekly_payment_adopt_proofs_identity_check" CHECK ("weekly_payment_ledger_adoption_allocation_proofs"."amount_minor" > 0 AND "weekly_payment_ledger_adoption_allocation_proofs"."currency" = 'USD' AND "weekly_payment_ledger_adoption_allocation_proofs"."correction_count" >= 0 AND "weekly_payment_ledger_adoption_allocation_proofs"."correction_lineage_fingerprint" ~ '^lvweeklyadoptcorr:v1:[0-9a-f]{64}$' AND (("weekly_payment_ledger_adoption_allocation_proofs"."funding_application_id" IS NOT NULL AND "weekly_payment_ledger_adoption_allocation_proofs"."rotating_application_id" IS NULL) OR ("weekly_payment_ledger_adoption_allocation_proofs"."funding_application_id" IS NULL AND "weekly_payment_ledger_adoption_allocation_proofs"."rotating_application_id" IS NOT NULL)) AND (("weekly_payment_ledger_adoption_allocation_proofs"."obligation_owner_kind" = 'bowler' AND "weekly_payment_ledger_adoption_allocation_proofs"."obligation_owner_bowler_id" IS NOT NULL AND "weekly_payment_ledger_adoption_allocation_proofs"."obligation_owner_team_id" IS NULL AND "weekly_payment_ledger_adoption_allocation_proofs"."credited_bowler_id" <> "weekly_payment_ledger_adoption_allocation_proofs"."obligation_owner_bowler_id") OR ("weekly_payment_ledger_adoption_allocation_proofs"."obligation_owner_kind" = 'team' AND "weekly_payment_ledger_adoption_allocation_proofs"."obligation_owner_bowler_id" IS NULL AND "weekly_payment_ledger_adoption_allocation_proofs"."obligation_owner_team_id" IS NOT NULL)))
);
--> statement-breakpoint
CREATE TABLE "weekly_payment_ledger_adoptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"adoption_version" integer DEFAULT 1 NOT NULL,
	"adopted_through_local_date" date NOT NULL,
	"preflight_fingerprint" varchar(96) NOT NULL,
	"result_fingerprint" varchar(96) NOT NULL,
	"grandfathered_allocation_count" integer DEFAULT 0 NOT NULL,
	"recorded_by_user_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "weekly_payment_ledger_adoptions_version_check" CHECK ("weekly_payment_ledger_adoptions"."adoption_version" = 1 AND "weekly_payment_ledger_adoptions"."grandfathered_allocation_count" >= 0),
	CONSTRAINT "weekly_payment_ledger_adoptions_fingerprint_check" CHECK ("weekly_payment_ledger_adoptions"."preflight_fingerprint" ~ '^lvweeklyadoptpre:v1:[0-9a-f]{64}$' AND "weekly_payment_ledger_adoptions"."result_fingerprint" ~ '^lvweeklyadopt:v1:[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "weekly_payment_week_confirmations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"occurrence_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"state_fingerprint" varchar(96) NOT NULL,
	"request_fingerprint" varchar(96) NOT NULL,
	"responsibility_set_fingerprint" varchar(96) NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"request_snapshot" jsonb NOT NULL,
	"recorded_by_user_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "weekly_payment_week_confirmations_revision_check" CHECK ("weekly_payment_week_confirmations"."revision" > 0 AND "weekly_payment_week_confirmations"."idempotency_key" ~ '^[A-Za-z0-9_-]{16,128}$'),
	CONSTRAINT "weekly_payment_week_confirmations_fingerprint_check" CHECK ("weekly_payment_week_confirmations"."state_fingerprint" ~ '^lvmanagepayments:v1:[0-9a-f]{64}$' AND "weekly_payment_week_confirmations"."request_fingerprint" ~ '^lvmanagepaymentsrequest:v1:[0-9a-f]{64}$' AND "weekly_payment_week_confirmations"."responsibility_set_fingerprint" ~ '^lvmanagepaymentsrows:v1:[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "weekly_payment_worksheet_receipt_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"receipt_id" uuid NOT NULL,
	"receipt_revision" integer NOT NULL,
	"payment_id" integer,
	"revision_kind" text NOT NULL,
	"amount_minor" integer NOT NULL,
	"business_collection_local_date" date NOT NULL,
	"recorded_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "weekly_payment_worksheet_receipt_revisions_revision_check" CHECK ("weekly_payment_worksheet_receipt_revisions"."receipt_revision" > 0 AND "weekly_payment_worksheet_receipt_revisions"."amount_minor" >= 0 AND (("weekly_payment_worksheet_receipt_revisions"."payment_id" IS NULL AND "weekly_payment_worksheet_receipt_revisions"."amount_minor" = 0 AND "weekly_payment_worksheet_receipt_revisions"."revision_kind" = 'manual_clear') OR ("weekly_payment_worksheet_receipt_revisions"."payment_id" IS NOT NULL AND "weekly_payment_worksheet_receipt_revisions"."amount_minor" > 0 AND "weekly_payment_worksheet_receipt_revisions"."revision_kind" <> 'manual_clear')) AND "weekly_payment_worksheet_receipt_revisions"."revision_kind" IN ('manual_record', 'manual_edit', 'manual_clear', 'card_association')),
	CONSTRAINT "weekly_payment_worksheet_receipt_revisions_actor_check" CHECK (("weekly_payment_worksheet_receipt_revisions"."revision_kind" = 'card_association' AND "weekly_payment_worksheet_receipt_revisions"."recorded_by_user_id" IS NULL) OR ("weekly_payment_worksheet_receipt_revisions"."revision_kind" <> 'card_association' AND "weekly_payment_worksheet_receipt_revisions"."recorded_by_user_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "weekly_payment_worksheet_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"occurrence_id" uuid NOT NULL,
	"payer_bowler_id" integer NOT NULL,
	"receipt_kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "weekly_payment_worksheet_receipts_kind_check" CHECK ("weekly_payment_worksheet_receipts"."receipt_kind" IN ('manual', 'card'))
);
--> statement-breakpoint
ALTER TABLE "occurrence_payment_responsibilities" DROP CONSTRAINT "occurrence_payment_responsibilities_kind_check";--> statement-breakpoint
ALTER TABLE "occurrence_payment_responsibilities" ALTER COLUMN "slot_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "occurrence_payment_responsibilities" ALTER COLUMN "slot_index" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "occurrence_payment_responsibilities" ALTER COLUMN "position_index" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "occurrence_payment_responsibilities" ALTER COLUMN "policy" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "occurrence_payment_responsibilities" ADD COLUMN "worksheet_fee_component" text;--> statement-breakpoint
CREATE UNIQUE INDEX "pay_alloc_fund_apps_alloc_uq" ON "payment_allocation_funding_applications" USING btree ("allocation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pay_alloc_fund_apps_tenant_uq" ON "payment_allocation_funding_applications" USING btree ("id","organization_id","league_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pay_alloc_fund_apps_source_identity_uq" ON "payment_allocation_funding_applications" USING btree ("id","organization_id","league_id","payment_id","credited_bowler_id","allocation_id","obligation_id","amount_minor","currency");--> statement-breakpoint
CREATE UNIQUE INDEX "weekly_payment_allocation_releases_tenant_identity_unique" ON "weekly_payment_allocation_releases" USING btree ("id","organization_id","league_id");--> statement-breakpoint
CREATE UNIQUE INDEX "weekly_payment_allocation_releases_source_allocation_unique" ON "weekly_payment_allocation_releases" USING btree ("source_allocation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "weekly_payment_allocation_releases_replacement_unique" ON "weekly_payment_allocation_releases" USING btree ("replacement_allocation_id") WHERE "weekly_payment_allocation_releases"."replacement_allocation_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "weekly_payment_allocation_releases_idempotency_unique" ON "weekly_payment_allocation_releases" USING btree ("organization_id","league_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "weekly_payment_funding_auth_items_tenant_uq" ON "weekly_payment_funding_authorization_items" USING btree ("id","organization_id","league_id");--> statement-breakpoint
CREATE UNIQUE INDEX "weekly_payment_funding_auth_items_portion_uq" ON "weekly_payment_funding_authorization_items" USING btree ("organization_id","league_id","funding_id","source_allocation_index");--> statement-breakpoint
CREATE UNIQUE INDEX "weekly_payment_funding_auth_items_operation_uq" ON "weekly_payment_funding_authorization_items" USING btree ("organization_id","league_id","source_operation_id","source_allocation_index");--> statement-breakpoint
CREATE UNIQUE INDEX "weekly_payment_fundings_payment_owner_uq" ON "weekly_payment_fundings" USING btree ("payment_id","credited_bowler_id");--> statement-breakpoint
CREATE UNIQUE INDEX "weekly_payment_fundings_portion_order_uq" ON "weekly_payment_fundings" USING btree ("payment_id","portion_index");--> statement-breakpoint
CREATE UNIQUE INDEX "weekly_payment_fundings_source_identity_uq" ON "weekly_payment_fundings" USING btree ("id","organization_id","league_id","payment_id","credited_bowler_id","amount_minor","currency");--> statement-breakpoint
CREATE UNIQUE INDEX "weekly_payment_fundings_auth_identity_uq" ON "weekly_payment_fundings" USING btree ("id","organization_id","league_id","payment_id","credited_bowler_id","authorization_operation_id","authorization_fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "weekly_payment_adopt_steps_index_uq" ON "weekly_payment_ledger_adoption_allocation_proof_steps" USING btree ("organization_id","league_id","proof_id","step_index");--> statement-breakpoint
CREATE UNIQUE INDEX "weekly_payment_adopt_steps_corr_uq" ON "weekly_payment_ledger_adoption_allocation_proof_steps" USING btree ("organization_id","league_id","proof_id","correction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "weekly_payment_adopt_proofs_id_tenant_uq" ON "weekly_payment_ledger_adoption_allocation_proofs" USING btree ("id","organization_id","league_id");--> statement-breakpoint
CREATE UNIQUE INDEX "weekly_payment_adopt_proofs_adoption_alloc_uq" ON "weekly_payment_ledger_adoption_allocation_proofs" USING btree ("organization_id","league_id","adoption_id","allocation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "weekly_payment_adopt_proofs_week_app_uq" ON "weekly_payment_ledger_adoption_allocation_proofs" USING btree ("funding_application_id") WHERE "weekly_payment_ledger_adoption_allocation_proofs"."funding_application_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "weekly_payment_adopt_proofs_rot_app_uq" ON "weekly_payment_ledger_adoption_allocation_proofs" USING btree ("rotating_application_id") WHERE "weekly_payment_ledger_adoption_allocation_proofs"."rotating_application_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "weekly_payment_ledger_adoptions_league_unique" ON "weekly_payment_ledger_adoptions" USING btree ("organization_id","league_id");--> statement-breakpoint
CREATE UNIQUE INDEX "weekly_payment_ledger_adoptions_id_org_league_unique" ON "weekly_payment_ledger_adoptions" USING btree ("id","organization_id","league_id");--> statement-breakpoint
CREATE UNIQUE INDEX "weekly_payment_week_confirmations_tenant_identity_unique" ON "weekly_payment_week_confirmations" USING btree ("id","organization_id","league_id");--> statement-breakpoint
CREATE UNIQUE INDEX "weekly_payment_week_confirmations_revision_unique" ON "weekly_payment_week_confirmations" USING btree ("organization_id","league_id","occurrence_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "weekly_payment_week_confirmations_idempotency_unique" ON "weekly_payment_week_confirmations" USING btree ("organization_id","league_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "weekly_payment_receipt_revisions_tenant_identity_unique" ON "weekly_payment_worksheet_receipt_revisions" USING btree ("id","organization_id","league_id");--> statement-breakpoint
CREATE UNIQUE INDEX "weekly_payment_receipt_revisions_receipt_revision_unique" ON "weekly_payment_worksheet_receipt_revisions" USING btree ("organization_id","league_id","receipt_id","receipt_revision");--> statement-breakpoint
CREATE UNIQUE INDEX "weekly_payment_receipt_revisions_payment_receipt_uq" ON "weekly_payment_worksheet_receipt_revisions" USING btree ("payment_id","receipt_id") WHERE "weekly_payment_worksheet_receipt_revisions"."payment_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "weekly_payment_worksheet_receipts_id_org_league_unique" ON "weekly_payment_worksheet_receipts" USING btree ("id","organization_id","league_id");--> statement-breakpoint
CREATE UNIQUE INDEX "weekly_payment_worksheet_receipts_scope_identity_unique" ON "weekly_payment_worksheet_receipts" USING btree ("id","organization_id","league_id","occurrence_id","payer_bowler_id","receipt_kind");--> statement-breakpoint
CREATE UNIQUE INDEX "occurrence_payment_responsibilities_worksheet_version_unique" ON "occurrence_payment_responsibilities" USING btree ("organization_id","league_id","occurrence_id","payer_bowler_id","version") WHERE "occurrence_payment_responsibilities"."responsibility_kind" = 'worksheet';--> statement-breakpoint
CREATE UNIQUE INDEX "occ_pay_resp_app_target_uq" ON "occurrence_payment_responsibilities" USING btree ("id","organization_id","league_id","occurrence_id","team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "occ_pay_resp_worksheet_current_payer_uq" ON "occurrence_payment_responsibilities" USING btree ("organization_id","league_id","occurrence_id","payer_bowler_id") WHERE "occurrence_payment_responsibilities"."state" = 'active' AND "occurrence_payment_responsibilities"."responsibility_kind" = 'worksheet';--> statement-breakpoint
CREATE UNIQUE INDEX "pay_alloc_corr_app_lineage_uq" ON "payment_allocation_corrections" USING btree ("id","organization_id","league_id","payment_id","source_allocation_id","replacement_allocation_id","amount_minor");--> statement-breakpoint
CREATE UNIQUE INDEX "pay_alloc_app_identity_uq" ON "payment_allocations" USING btree ("id","organization_id","league_id","payment_id","obligation_id","amount_minor","currency");--> statement-breakpoint
CREATE UNIQUE INDEX "pay_obl_app_identity_uq" ON "payment_obligations" USING btree ("id","organization_id","league_id","responsibility_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pay_obl_app_payer_uq" ON "payment_obligations" USING btree ("id","organization_id","league_id","responsibility_id","payer_bowler_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pay_op_snap_item_auth_uq" ON "payment_operation_roster_snapshot_items" USING btree ("operation_id","organization_id","league_id","allocation_index","amount_minor");--> statement-breakpoint
CREATE UNIQUE INDEX "rot_occ_assign_app_target_uq" ON "rotating_occurrence_assignments" USING btree ("id","organization_id","league_id","occurrence_id","team_id","responsibility_id","actual_bowler_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rot_app_adopt_src_uq" ON "rotating_credit_applications" USING btree ("id","organization_id","league_id","payment_id","actual_bowler_id","allocation_id","obligation_id","amount_minor");--> statement-breakpoint
CREATE UNIQUE INDEX "rot_fund_app_source_uq" ON "rotating_credit_fundings" USING btree ("id","organization_id","league_id","payment_id","bowler_id","amount_minor","currency");--> statement-breakpoint
ALTER TABLE "payment_allocation_funding_applications" ADD CONSTRAINT "pay_alloc_fund_apps_org_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocation_funding_applications" ADD CONSTRAINT "pay_alloc_fund_apps_actor_fk" FOREIGN KEY ("applied_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocation_funding_applications" ADD CONSTRAINT "pay_alloc_fund_apps_league_fk" FOREIGN KEY ("league_id","organization_id") REFERENCES "public"."leagues"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocation_funding_applications" ADD CONSTRAINT "pay_alloc_fund_apps_owner_fk" FOREIGN KEY ("credited_bowler_id","organization_id") REFERENCES "public"."bowlers"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocation_funding_applications" ADD CONSTRAINT "pay_alloc_fund_apps_allocation_fk" FOREIGN KEY ("allocation_id","organization_id","league_id","payment_id","obligation_id","amount_minor","currency") REFERENCES "public"."payment_allocations"("id","organization_id","league_id","payment_id","obligation_id","amount_minor","currency") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocation_funding_applications" ADD CONSTRAINT "pay_alloc_fund_apps_generic_fk" FOREIGN KEY ("generic_funding_id","organization_id","league_id","payment_id","credited_bowler_id","source_amount_minor","currency") REFERENCES "public"."weekly_payment_fundings"("id","organization_id","league_id","payment_id","credited_bowler_id","amount_minor","currency") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocation_funding_applications" ADD CONSTRAINT "pay_alloc_fund_apps_rotating_fk" FOREIGN KEY ("rotating_funding_id","organization_id","league_id","payment_id","credited_bowler_id","source_amount_minor","currency") REFERENCES "public"."rotating_credit_fundings"("id","organization_id","league_id","payment_id","bowler_id","amount_minor","currency") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocation_funding_applications" ADD CONSTRAINT "pay_alloc_fund_apps_obligation_fk" FOREIGN KEY ("obligation_id","organization_id","league_id","responsibility_id") REFERENCES "public"."payment_obligations"("id","organization_id","league_id","responsibility_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocation_funding_applications" ADD CONSTRAINT "pay_alloc_fund_apps_payer_fk" FOREIGN KEY ("obligation_id","organization_id","league_id","responsibility_id","target_payer_bowler_id") REFERENCES "public"."payment_obligations"("id","organization_id","league_id","responsibility_id","payer_bowler_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocation_funding_applications" ADD CONSTRAINT "pay_alloc_fund_apps_resp_fk" FOREIGN KEY ("responsibility_id","organization_id","league_id","occurrence_id","team_id") REFERENCES "public"."occurrence_payment_responsibilities"("id","organization_id","league_id","occurrence_id","team_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocation_funding_applications" ADD CONSTRAINT "pay_alloc_fund_apps_assign_fk" FOREIGN KEY ("assignment_id","organization_id","league_id","occurrence_id","team_id","responsibility_id","credited_bowler_id") REFERENCES "public"."rotating_occurrence_assignments"("id","organization_id","league_id","occurrence_id","team_id","responsibility_id","actual_bowler_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_payment_allocation_releases" ADD CONSTRAINT "weekly_payment_allocation_releases_org_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_payment_allocation_releases" ADD CONSTRAINT "weekly_payment_allocation_releases_actor_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_payment_allocation_releases" ADD CONSTRAINT "weekly_payment_allocation_releases_league_tenant_fk" FOREIGN KEY ("league_id","organization_id") REFERENCES "public"."leagues"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_payment_allocation_releases" ADD CONSTRAINT "weekly_payment_allocation_releases_app_fk" FOREIGN KEY ("funding_application_id","organization_id","league_id","payment_id","credited_bowler_id","source_allocation_id","source_obligation_id","source_application_amount_minor","currency") REFERENCES "public"."payment_allocation_funding_applications"("id","organization_id","league_id","payment_id","credited_bowler_id","allocation_id","obligation_id","amount_minor","currency") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_payment_allocation_releases" ADD CONSTRAINT "weekly_payment_allocation_releases_source_allocation_fk" FOREIGN KEY ("source_allocation_id","organization_id","league_id") REFERENCES "public"."payment_allocations"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_payment_allocation_releases" ADD CONSTRAINT "weekly_payment_allocation_releases_source_obligation_fk" FOREIGN KEY ("source_obligation_id","organization_id","league_id") REFERENCES "public"."payment_obligations"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_payment_allocation_releases" ADD CONSTRAINT "weekly_payment_allocation_releases_replacement_allocation_fk" FOREIGN KEY ("replacement_allocation_id","organization_id","league_id") REFERENCES "public"."payment_allocations"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_payment_funding_authorization_items" ADD CONSTRAINT "weekly_payment_funding_auth_items_org_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_payment_funding_authorization_items" ADD CONSTRAINT "weekly_payment_funding_auth_items_league_fk" FOREIGN KEY ("league_id","organization_id") REFERENCES "public"."leagues"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_payment_funding_authorization_items" ADD CONSTRAINT "weekly_payment_funding_auth_items_funding_fk" FOREIGN KEY ("funding_id","organization_id","league_id","payment_id","credited_bowler_id","source_operation_id","source_snapshot_fingerprint") REFERENCES "public"."weekly_payment_fundings"("id","organization_id","league_id","payment_id","credited_bowler_id","authorization_operation_id","authorization_fingerprint") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_payment_funding_authorization_items" ADD CONSTRAINT "weekly_payment_funding_auth_items_item_fk" FOREIGN KEY ("source_operation_id","organization_id","league_id","source_allocation_index","authorized_amount_minor") REFERENCES "public"."payment_operation_roster_snapshot_items"("operation_id","organization_id","league_id","allocation_index","amount_minor") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_payment_fundings" ADD CONSTRAINT "weekly_payment_fundings_org_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_payment_fundings" ADD CONSTRAINT "weekly_payment_fundings_actor_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_payment_fundings" ADD CONSTRAINT "weekly_payment_fundings_league_tenant_fk" FOREIGN KEY ("league_id","organization_id") REFERENCES "public"."leagues"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_payment_fundings" ADD CONSTRAINT "weekly_payment_fundings_owner_tenant_fk" FOREIGN KEY ("credited_bowler_id","organization_id") REFERENCES "public"."bowlers"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_payment_fundings" ADD CONSTRAINT "weekly_payment_fundings_payment_fk" FOREIGN KEY ("payment_id","organization_id","league_id") REFERENCES "public"."payments"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_payment_fundings" ADD CONSTRAINT "weekly_payment_fundings_adoption_fk" FOREIGN KEY ("adoption_id","organization_id","league_id") REFERENCES "public"."weekly_payment_ledger_adoptions"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_payment_fundings" ADD CONSTRAINT "weekly_payment_fundings_auth_op_fk" FOREIGN KEY ("authorization_operation_id","organization_id","league_id") REFERENCES "public"."payment_operations"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_payment_ledger_adoption_allocation_proof_steps" ADD CONSTRAINT "weekly_payment_adopt_steps_org_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_payment_ledger_adoption_allocation_proof_steps" ADD CONSTRAINT "weekly_payment_adopt_steps_league_fk" FOREIGN KEY ("league_id","organization_id") REFERENCES "public"."leagues"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_payment_ledger_adoption_allocation_proof_steps" ADD CONSTRAINT "weekly_payment_adopt_steps_proof_fk" FOREIGN KEY ("proof_id","organization_id","league_id") REFERENCES "public"."weekly_payment_ledger_adoption_allocation_proofs"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_payment_ledger_adoption_allocation_proof_steps" ADD CONSTRAINT "weekly_payment_adopt_steps_correction_fk" FOREIGN KEY ("correction_id","organization_id","league_id","payment_id","source_allocation_id","replacement_allocation_id","amount_minor") REFERENCES "public"."payment_allocation_corrections"("id","organization_id","league_id","payment_id","source_allocation_id","replacement_allocation_id","amount_minor") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_payment_ledger_adoption_allocation_proofs" ADD CONSTRAINT "weekly_payment_adopt_proofs_org_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_payment_ledger_adoption_allocation_proofs" ADD CONSTRAINT "weekly_payment_adopt_alloc_proofs_league_tenant_fk" FOREIGN KEY ("league_id","organization_id") REFERENCES "public"."leagues"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_payment_ledger_adoption_allocation_proofs" ADD CONSTRAINT "weekly_payment_adopt_alloc_proofs_adoption_fk" FOREIGN KEY ("adoption_id","organization_id","league_id") REFERENCES "public"."weekly_payment_ledger_adoptions"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_payment_ledger_adoption_allocation_proofs" ADD CONSTRAINT "weekly_payment_adopt_proofs_weekly_app_fk" FOREIGN KEY ("funding_application_id","organization_id","league_id","payment_id","credited_bowler_id","allocation_id","obligation_id","amount_minor","currency") REFERENCES "public"."payment_allocation_funding_applications"("id","organization_id","league_id","payment_id","credited_bowler_id","allocation_id","obligation_id","amount_minor","currency") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_payment_ledger_adoption_allocation_proofs" ADD CONSTRAINT "weekly_payment_adopt_proofs_rot_app_fk" FOREIGN KEY ("rotating_application_id","organization_id","league_id","payment_id","credited_bowler_id","allocation_id","obligation_id","amount_minor") REFERENCES "public"."rotating_credit_applications"("id","organization_id","league_id","payment_id","actual_bowler_id","allocation_id","obligation_id","amount_minor") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_payment_ledger_adoption_allocation_proofs" ADD CONSTRAINT "weekly_payment_adopt_alloc_proofs_allocation_fk" FOREIGN KEY ("allocation_id","organization_id","league_id") REFERENCES "public"."payment_allocations"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_payment_ledger_adoption_allocation_proofs" ADD CONSTRAINT "weekly_payment_adopt_proofs_original_fk" FOREIGN KEY ("original_allocation_id","organization_id","league_id") REFERENCES "public"."payment_allocations"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_payment_ledger_adoption_allocation_proofs" ADD CONSTRAINT "weekly_payment_adopt_alloc_proofs_obligation_fk" FOREIGN KEY ("obligation_id","organization_id","league_id") REFERENCES "public"."payment_obligations"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_payment_ledger_adoption_allocation_proofs" ADD CONSTRAINT "weekly_payment_adopt_proofs_bowler_fk" FOREIGN KEY ("obligation_owner_bowler_id","organization_id") REFERENCES "public"."bowlers"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_payment_ledger_adoption_allocation_proofs" ADD CONSTRAINT "weekly_payment_adopt_proofs_team_fk" FOREIGN KEY ("obligation_owner_team_id","league_id") REFERENCES "public"."teams"("id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_payment_ledger_adoptions" ADD CONSTRAINT "weekly_payment_ledger_adoptions_org_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_payment_ledger_adoptions" ADD CONSTRAINT "weekly_payment_ledger_adoptions_actor_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_payment_ledger_adoptions" ADD CONSTRAINT "weekly_payment_ledger_adoptions_league_tenant_fk" FOREIGN KEY ("league_id","organization_id") REFERENCES "public"."leagues"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_payment_week_confirmations" ADD CONSTRAINT "weekly_payment_week_confirmations_org_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_payment_week_confirmations" ADD CONSTRAINT "weekly_payment_week_confirmations_actor_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_payment_week_confirmations" ADD CONSTRAINT "weekly_payment_week_confirmations_league_tenant_fk" FOREIGN KEY ("league_id","organization_id") REFERENCES "public"."leagues"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_payment_week_confirmations" ADD CONSTRAINT "weekly_payment_week_confirmations_occurrence_fk" FOREIGN KEY ("occurrence_id","organization_id","league_id") REFERENCES "public"."league_occurrences"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_payment_worksheet_receipt_revisions" ADD CONSTRAINT "weekly_payment_receipt_revisions_org_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_payment_worksheet_receipt_revisions" ADD CONSTRAINT "weekly_payment_receipt_revisions_actor_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_payment_worksheet_receipt_revisions" ADD CONSTRAINT "weekly_payment_worksheet_receipt_revisions_league_tenant_fk" FOREIGN KEY ("league_id","organization_id") REFERENCES "public"."leagues"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_payment_worksheet_receipt_revisions" ADD CONSTRAINT "weekly_payment_worksheet_receipt_revisions_receipt_fk" FOREIGN KEY ("receipt_id","organization_id","league_id") REFERENCES "public"."weekly_payment_worksheet_receipts"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_payment_worksheet_receipt_revisions" ADD CONSTRAINT "weekly_payment_worksheet_receipt_revisions_payment_fk" FOREIGN KEY ("payment_id","organization_id","league_id") REFERENCES "public"."payments"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_payment_worksheet_receipts" ADD CONSTRAINT "weekly_payment_worksheet_receipts_org_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_payment_worksheet_receipts" ADD CONSTRAINT "weekly_payment_worksheet_receipts_league_tenant_fk" FOREIGN KEY ("league_id","organization_id") REFERENCES "public"."leagues"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_payment_worksheet_receipts" ADD CONSTRAINT "weekly_payment_worksheet_receipts_occurrence_fk" FOREIGN KEY ("occurrence_id","organization_id","league_id") REFERENCES "public"."league_occurrences"("id","organization_id","league_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_payment_worksheet_receipts" ADD CONSTRAINT "weekly_payment_worksheet_receipts_payer_fk" FOREIGN KEY ("payer_bowler_id","organization_id") REFERENCES "public"."bowlers"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pay_alloc_fund_apps_funding_idx" ON "payment_allocation_funding_applications" USING btree ("organization_id","league_id","generic_funding_id","rotating_funding_id","created_at");--> statement-breakpoint
CREATE INDEX "pay_alloc_fund_apps_target_idx" ON "payment_allocation_funding_applications" USING btree ("organization_id","league_id","credited_bowler_id","occurrence_id");--> statement-breakpoint
CREATE INDEX "weekly_payment_allocation_releases_owner_ledger_idx" ON "weekly_payment_allocation_releases" USING btree ("organization_id","league_id","credited_bowler_id","created_at");--> statement-breakpoint
CREATE INDEX "weekly_payment_fundings_owner_ledger_idx" ON "weekly_payment_fundings" USING btree ("organization_id","league_id","credited_bowler_id","created_at","id");--> statement-breakpoint
CREATE INDEX "weekly_payment_adopt_proofs_alloc_idx" ON "weekly_payment_ledger_adoption_allocation_proofs" USING btree ("organization_id","league_id","allocation_id");--> statement-breakpoint
CREATE INDEX "weekly_payment_week_confirmations_occurrence_revision_idx" ON "weekly_payment_week_confirmations" USING btree ("organization_id","league_id","occurrence_id","revision");--> statement-breakpoint
CREATE INDEX "weekly_payment_worksheet_receipt_revisions_receipt_idx" ON "weekly_payment_worksheet_receipt_revisions" USING btree ("organization_id","league_id","receipt_id","receipt_revision");--> statement-breakpoint
CREATE INDEX "weekly_payment_worksheet_receipts_payer_occurrence_idx" ON "weekly_payment_worksheet_receipts" USING btree ("organization_id","league_id","payer_bowler_id","occurrence_id");--> statement-breakpoint
ALTER TABLE "occurrence_payment_responsibilities" ADD CONSTRAINT "occurrence_payment_responsibilities_identity_shape_check" CHECK ((
    "occurrence_payment_responsibilities"."responsibility_kind" = 'worksheet'
    AND "occurrence_payment_responsibilities"."slot_id" IS NULL
    AND "occurrence_payment_responsibilities"."slot_index" IS NULL
    AND "occurrence_payment_responsibilities"."position_index" IS NULL
    AND "occurrence_payment_responsibilities"."policy" IS NULL
    AND "occurrence_payment_responsibilities"."worksheet_fee_component" IN ('full', 'lineage', 'prize')
  ) OR (
    "occurrence_payment_responsibilities"."responsibility_kind" <> 'worksheet'
    AND "occurrence_payment_responsibilities"."slot_id" IS NOT NULL
    AND "occurrence_payment_responsibilities"."slot_index" IS NOT NULL
    AND "occurrence_payment_responsibilities"."position_index" IS NOT NULL
    AND "occurrence_payment_responsibilities"."policy" IS NOT NULL
    AND "occurrence_payment_responsibilities"."worksheet_fee_component" IS NULL
  ));--> statement-breakpoint
ALTER TABLE "occurrence_payment_responsibilities" ADD CONSTRAINT "occurrence_payment_responsibilities_kind_check" CHECK ("occurrence_payment_responsibilities"."responsibility_kind" IN ('main', 'substitute', 'split', 'vacant', 'rotating', 'worksheet') AND ((
    "occurrence_payment_responsibilities"."responsibility_kind" = 'vacant' AND "occurrence_payment_responsibilities"."main_bowler_id" IS NULL AND "occurrence_payment_responsibilities"."substitute_bowler_id" IS NULL AND "occurrence_payment_responsibilities"."payer_bowler_id" IS NULL AND "occurrence_payment_responsibilities"."amount_minor" = 0 AND "occurrence_payment_responsibilities"."lineage_amount_minor" IS NULL AND "occurrence_payment_responsibilities"."prize_fund_amount_minor" IS NULL
  ) OR (
    "occurrence_payment_responsibilities"."responsibility_kind" = 'main' AND "occurrence_payment_responsibilities"."main_bowler_id" IS NOT NULL AND "occurrence_payment_responsibilities"."substitute_bowler_id" IS NULL AND "occurrence_payment_responsibilities"."payer_bowler_id" IS NOT NULL AND "occurrence_payment_responsibilities"."payer_bowler_id" = "occurrence_payment_responsibilities"."main_bowler_id" AND "occurrence_payment_responsibilities"."amount_minor" > 0
  ) OR (
    "occurrence_payment_responsibilities"."responsibility_kind" = 'substitute' AND "occurrence_payment_responsibilities"."main_bowler_id" IS NOT NULL AND "occurrence_payment_responsibilities"."substitute_bowler_id" IS NOT NULL AND "occurrence_payment_responsibilities"."main_bowler_id" <> "occurrence_payment_responsibilities"."substitute_bowler_id" AND "occurrence_payment_responsibilities"."payer_bowler_id" IS NOT NULL AND "occurrence_payment_responsibilities"."amount_minor" > 0
  ) OR (
    "occurrence_payment_responsibilities"."responsibility_kind" = 'split' AND "occurrence_payment_responsibilities"."main_bowler_id" IS NOT NULL AND "occurrence_payment_responsibilities"."substitute_bowler_id" IS NOT NULL AND "occurrence_payment_responsibilities"."main_bowler_id" <> "occurrence_payment_responsibilities"."substitute_bowler_id" AND "occurrence_payment_responsibilities"."payer_bowler_id" IS NOT NULL AND "occurrence_payment_responsibilities"."amount_minor" > 0
  ) OR (
    "occurrence_payment_responsibilities"."responsibility_kind" = 'rotating' AND "occurrence_payment_responsibilities"."main_bowler_id" IS NULL AND "occurrence_payment_responsibilities"."substitute_bowler_id" IS NULL AND "occurrence_payment_responsibilities"."payer_bowler_id" IS NULL AND "occurrence_payment_responsibilities"."amount_minor" > 0
  ) OR (
    "occurrence_payment_responsibilities"."responsibility_kind" = 'worksheet' AND "occurrence_payment_responsibilities"."main_bowler_id" IS NULL AND "occurrence_payment_responsibilities"."substitute_bowler_id" IS NULL AND "occurrence_payment_responsibilities"."payer_bowler_id" IS NOT NULL AND "occurrence_payment_responsibilities"."lineage_payer_bowler_id" IS NULL AND "occurrence_payment_responsibilities"."prize_payer_bowler_id" IS NULL AND "occurrence_payment_responsibilities"."amount_minor" >= 0 AND "occurrence_payment_responsibilities"."worksheet_fee_component" IS NOT NULL AND "occurrence_payment_responsibilities"."lineage_amount_minor" IS NULL AND "occurrence_payment_responsibilities"."prize_fund_amount_minor" IS NULL
  )) AND (("occurrence_payment_responsibilities"."responsibility_kind" = 'split' AND "occurrence_payment_responsibilities"."lineage_payer_bowler_id" IS NOT NULL AND "occurrence_payment_responsibilities"."prize_payer_bowler_id" IS NOT NULL AND "occurrence_payment_responsibilities"."lineage_amount_minor" IS NOT NULL AND "occurrence_payment_responsibilities"."prize_fund_amount_minor" IS NOT NULL AND "occurrence_payment_responsibilities"."lineage_amount_minor" >= 0 AND "occurrence_payment_responsibilities"."prize_fund_amount_minor" >= 0 AND "occurrence_payment_responsibilities"."lineage_amount_minor" + "occurrence_payment_responsibilities"."prize_fund_amount_minor" = "occurrence_payment_responsibilities"."amount_minor" AND "occurrence_payment_responsibilities"."amount_minor" > 0) OR ("occurrence_payment_responsibilities"."responsibility_kind" <> 'split' AND "occurrence_payment_responsibilities"."lineage_payer_bowler_id" IS NULL AND "occurrence_payment_responsibilities"."prize_payer_bowler_id" IS NULL AND "occurrence_payment_responsibilities"."lineage_amount_minor" IS NULL AND "occurrence_payment_responsibilities"."prize_fund_amount_minor" IS NULL)));