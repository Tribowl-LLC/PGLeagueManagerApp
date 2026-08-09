import { sql } from "drizzle-orm";
import { db } from "../db.js";

export type CanonicalOccurrenceEvidenceExecutor =
  | typeof db
  | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Return only the existence bit for retained A1 league evidence. Keeping the
 * table list here makes ordinary deletion fail closed for every current and
 * audit entity without exposing a table name or constraint to the route.
 */
export async function hasLeagueOccurrenceEvidence(
  tx: CanonicalOccurrenceEvidenceExecutor,
  organizationId: number | null,
  leagueId: number,
): Promise<boolean> {
  if (organizationId === null) return false;

  const result = await tx.execute(sql`
    SELECT EXISTS (
      SELECT 1 FROM league_schedule_commands
       WHERE organization_id = ${organizationId} AND league_id = ${leagueId}
      UNION ALL
      SELECT 1 FROM league_occurrence_generation_runs
       WHERE organization_id = ${organizationId} AND league_id = ${leagueId}
      UNION ALL
      SELECT 1 FROM league_schedule_exceptions
       WHERE organization_id = ${organizationId} AND league_id = ${leagueId}
      UNION ALL
      SELECT 1 FROM league_occurrences
       WHERE organization_id = ${organizationId} AND league_id = ${leagueId}
      UNION ALL
      SELECT 1 FROM league_occurrence_billing_terms
       WHERE organization_id = ${organizationId} AND league_id = ${leagueId}
      UNION ALL
      SELECT 1 FROM league_occurrence_relationships
       WHERE organization_id = ${organizationId} AND league_id = ${leagueId}
      UNION ALL
      SELECT 1 FROM league_occurrence_revisions
       WHERE organization_id = ${organizationId} AND league_id = ${leagueId}
      UNION ALL
      SELECT 1 FROM league_schedule_exception_revisions
       WHERE organization_id = ${organizationId} AND league_id = ${leagueId}
      UNION ALL
      SELECT 1 FROM league_occurrence_relationship_revisions
       WHERE organization_id = ${organizationId} AND league_id = ${leagueId}
      UNION ALL
      SELECT 1 FROM league_occurrence_billing_term_revisions
       WHERE organization_id = ${organizationId} AND league_id = ${leagueId}
      UNION ALL
      SELECT 1 FROM league_occurrence_generation_discrepancies
       WHERE organization_id = ${organizationId} AND league_id = ${leagueId}
    ) AS has_evidence
  `);

  return result.rows[0]?.has_evidence === true;
}

/**
 * Occurrence rows are the A1 evidence that directly retains a location.
 * This is deliberately tenant-scoped and returns no row details.
 */
export async function hasLocationOccurrenceEvidence(
  tx: CanonicalOccurrenceEvidenceExecutor,
  organizationId: number,
  locationId: number,
): Promise<boolean> {
  const result = await tx.execute(sql`
    SELECT EXISTS (
      SELECT 1
        FROM league_occurrences
       WHERE organization_id = ${organizationId}
         AND location_id = ${locationId}
    ) AS has_evidence
  `);

  return result.rows[0]?.has_evidence === true;
}
