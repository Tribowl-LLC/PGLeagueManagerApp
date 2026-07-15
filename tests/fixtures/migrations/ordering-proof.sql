CREATE SCHEMA "migration_ordering_proof";--> statement-breakpoint
CREATE TABLE "migration_ordering_proof"."applied_after_baseline" (
  "id" integer PRIMARY KEY,
  "baseline_tag" text NOT NULL
);
