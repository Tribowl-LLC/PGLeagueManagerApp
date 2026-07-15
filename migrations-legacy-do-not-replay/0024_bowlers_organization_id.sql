-- Task #342: every bowler must record its owning organization.
--
-- Adds `bowlers.organization_id` as a nullable FK to `organizations` so we
-- can stamp every newly-created bowler with the org that owns it. The
-- column is intentionally left nullable (for now) because a small number
-- of legacy "orphan" bowlers cannot be matched to any organization via
-- their league memberships and must be triaged through the orphaned-data
-- tooling (`/admin/data-integrity`) before the column can be flipped to
-- NOT NULL. The follow-up migration that adds NOT NULL is tracked under
-- task #407.
--
-- Backfill rule: for every existing bowler with at least one active
-- bowler-league entry whose league has a non-null `organization_id`,
-- copy the FIRST such org id onto the bowler. Bowlers whose only league
-- entries reference org-less leagues, or who have no league entries at
-- all, are left NULL and surface in the orphan tooling.
--
-- Application-level enforcement (in `server/routes/bowlers.ts` and
-- `server/routes/bulk-import.ts`) already requires the column to be
-- populated on every newly-created bowler, so no NULL rows can be added
-- after this migration runs — the residual NULLs are strictly the
-- pre-existing legacy population.

ALTER TABLE "bowlers"
  ADD COLUMN IF NOT EXISTS "organization_id" integer;

--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "bowlers"
    ADD CONSTRAINT "bowlers_organization_id_organizations_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id")
    ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
-- Backfill from the first resolvable league/org linkage.
UPDATE "bowlers" AS b
SET    "organization_id" = sub.org_id
FROM (
  SELECT bl."bowler_id" AS bowler_id,
         (ARRAY_AGG(l."organization_id" ORDER BY bl."id"))[1] AS org_id
  FROM   "bowler_leagues" bl
  JOIN   "leagues" l ON l."id" = bl."league_id"
  WHERE  l."organization_id" IS NOT NULL
  GROUP  BY bl."bowler_id"
) AS sub
WHERE  b."id" = sub.bowler_id
  AND  b."organization_id" IS NULL;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bowlers_organization_id_idx"
  ON "bowlers" USING btree ("organization_id");
