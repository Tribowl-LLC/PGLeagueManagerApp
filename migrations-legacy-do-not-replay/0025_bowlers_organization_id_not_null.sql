-- Task #407: tighten `bowlers.organization_id` to NOT NULL.
--
-- Follow-up to migration 0024, which added the column as nullable so the
-- legacy "orphan" bowlers (no resolvable league/org link) could be triaged
-- through the orphaned-data tooling (`/admin/data-integrity`) before the
-- constraint was tightened. With those rows now triaged, every bowler row
-- must record its owning organization so the access-control layer can
-- treat the stamp as authoritative and reject org-less inserts at the
-- database boundary.
--
-- Application-level enforcement already requires the column on every
-- newly-created bowler (see `server/routes/bowlers.ts`,
-- `server/routes/bulk-import.ts`, and the `createBowler` storage
-- signature in `server/storage/bowlers.ts`). This migration adds the
-- matching schema-level guarantee.
--
-- Safety: the `DO` block first asserts that no bowler rows still have a
-- NULL organization_id. If any are found the migration aborts BEFORE the
-- ALTER, so deployments to environments that still hold legacy orphans
-- fail loudly instead of silently skipping the constraint.

DO $$
DECLARE
  null_count integer;
BEGIN
  SELECT COUNT(*) INTO null_count
  FROM "bowlers"
  WHERE "organization_id" IS NULL;

  IF null_count > 0 THEN
    RAISE EXCEPTION
      'Cannot set bowlers.organization_id NOT NULL: % row(s) still have a NULL organization_id. Triage them via /admin/data-integrity before re-running this migration (task #407).',
      null_count;
  END IF;
END $$;

--> statement-breakpoint
ALTER TABLE "bowlers" ALTER COLUMN "organization_id" SET NOT NULL;
