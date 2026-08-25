import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SCHEDULE_AUTHORITIES } from "@shared/schema/leagues";

describe("canonical schedule authority migration", () => {
  const migration = readFileSync("migrations/0034_canonical_schedule_authority.sql", "utf8");

  it("classifies from complete invariant evidence and fails closed on contradictions", () => {
    expect(SCHEDULE_AUTHORITIES).toEqual(["canonical", "retired_legacy"]);
    expect(migration).toContain("LOCK TABLE");
    expect(migration).toContain("0034 refused: partial or contradictory canonical evidence");
    expect(migration).toContain("state = 'applied'");
    expect(migration).toContain("resolution_state = 'open'");
    expect(migration).toContain("id AS league_id");
    expect(migration).toContain("r.candidate_occurrence_count <> r.generated_occurrence_count + r.skipped_date_count");
    expect(migration).toContain("state = 'published'");
    expect(migration).toContain("schedule_authority = CASE WHEN EXISTS");
  });

  it("retains legacy evidence and makes retired authority irreversible", () => {
    expect(migration).not.toMatch(/DROP\s+(?:COLUMN|TABLE)/i);
    expect(migration).toContain("leagues_schedule_authority_check");
    expect(migration).toContain("leagues_retired_legacy_inactive_check");
    expect(migration).toContain("enforce_league_schedule_authority_immutability");
    expect(migration).toContain("NEW IS DISTINCT FROM OLD");
    expect(migration).toContain("schedule_authority_active_idx");
  });
});
