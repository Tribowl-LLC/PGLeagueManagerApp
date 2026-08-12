import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  bowlerLeagues,
  bowlers,
  leagues,
  locations,
  organizations,
  teams,
  users,
} from "@shared/schema";
import type { LeagueOccurrenceScheduleReadContract } from "@shared/league-occurrence-schedule";
import type { FallDraftPreview } from "@shared/fall-draft-generation";
import type { FallDraftReview } from "@shared/fall-draft-review";
import { hashPassword } from "../../server/lib/password";
import { deleteOrganization } from "../../server/storage/organizations";
import {
  TEST_ADMIN_EMAIL,
  TEST_ADMIN_PASSWORD,
  apiGet,
  apiPost,
  login,
  type AuthSession,
} from "../helpers";
import { getTestDb } from "../setup/test-db";

const db = getTestDb();
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const password = "E1-local-password-1!";
const organizationsToDelete: number[] = [];

interface Fixture {
  organizationId: number;
  leagueId: number;
  admin: AuthSession;
  member: AuthSession;
  unrostered: AuthSession;
}

async function fixture(label: string): Promise<Fixture> {
  const [organization] = await db.insert(organizations).values({
    name: `E1 ${label}`,
    slug: `e1-${label}-${suffix}`,
  }).returning({ id: organizations.id });
  if (!organization) throw new Error("E1 organization was not created");
  organizationsToDelete.push(organization.id);
  const [location] = await db.insert(locations).values({
    name: `E1 ${label} lanes`,
    organizationId: organization.id,
  }).returning({ id: locations.id });
  if (!location) throw new Error("E1 location was not created");
  const [league] = await db.insert(leagues).values({
    name: `E1 ${label} Fall league`,
    organizationId: organization.id,
    locationId: location.id,
    seasonStart: "2032-08-01",
    seasonEnd: "2032-08-22",
    weekDay: "Sunday",
    competitionStartTime: "19:00",
    timezone: "America/Detroit",
    totalBowlingWeeks: 3,
    weeklyFee: 2_000,
    skipDates: ["2032-08-08"],
    cancelledDates: ["2032-08-15"],
    doublePayDates: ["2032-08-22"],
  }).returning({ id: leagues.id });
  if (!league) throw new Error("E1 league was not created");
  const [team] = await db.insert(teams).values({ name: `E1 ${label} team`, number: 1, leagueId: league.id }).returning({ id: teams.id });
  const [bowler] = await db.insert(bowlers).values({ name: `E1 ${label} bowler`, organizationId: organization.id }).returning({ id: bowlers.id });
  if (!team || !bowler) throw new Error("E1 roster fixture was not created");
  await db.insert(bowlerLeagues).values({ bowlerId: bowler.id, leagueId: league.id, teamId: team.id });
  const hashed = await hashPassword(password);
  const adminEmail = `e1-${label}-admin-${suffix}@example.test`;
  const memberEmail = `e1-${label}-member-${suffix}@example.test`;
  const unrosteredEmail = `e1-${label}-unrostered-${suffix}@example.test`;
  await db.insert(users).values([
    { email: adminEmail, password: hashed, name: `E1 ${label} admin`, role: "org_admin", organizationId: organization.id },
    { email: memberEmail, password: hashed, name: `E1 ${label} member`, role: "user", organizationId: organization.id, bowlerId: bowler.id },
    { email: unrosteredEmail, password: hashed, name: `E1 ${label} unrostered`, role: "user", organizationId: organization.id },
  ]);
  return {
    organizationId: organization.id,
    leagueId: league.id,
    admin: await login(adminEmail, password),
    member: await login(memberEmail, password),
    unrostered: await login(unrosteredEmail, password),
  };
}

async function writeSnapshot(leagueId: number): Promise<Record<string, string>> {
  const result = await db.execute<{ name: string; value: string }>(sql`
    SELECT 'league' AS name, row_to_json(l)::text AS value FROM leagues l WHERE l.id = ${leagueId}
    UNION ALL SELECT 'commands', count(*)::text FROM league_schedule_commands WHERE league_id = ${leagueId}
    UNION ALL SELECT 'runs', count(*)::text FROM league_occurrence_generation_runs WHERE league_id = ${leagueId}
    UNION ALL SELECT 'exceptions', count(*)::text FROM league_schedule_exceptions WHERE league_id = ${leagueId}
    UNION ALL SELECT 'occurrences', count(*)::text FROM league_occurrences WHERE league_id = ${leagueId}
    UNION ALL SELECT 'terms', count(*)::text FROM league_occurrence_billing_terms WHERE league_id = ${leagueId}
    UNION ALL SELECT 'relationships', count(*)::text FROM league_occurrence_relationships WHERE league_id = ${leagueId}
    UNION ALL SELECT 'occurrence_revisions', count(*)::text FROM league_occurrence_revisions WHERE league_id = ${leagueId}
    UNION ALL SELECT 'exception_revisions', count(*)::text FROM league_schedule_exception_revisions WHERE league_id = ${leagueId}
    UNION ALL SELECT 'relationship_revisions', count(*)::text FROM league_occurrence_relationship_revisions WHERE league_id = ${leagueId}
    UNION ALL SELECT 'term_revisions', count(*)::text FROM league_occurrence_billing_term_revisions WHERE league_id = ${leagueId}
    UNION ALL SELECT 'discrepancies', count(*)::text FROM league_occurrence_generation_discrepancies WHERE league_id = ${leagueId}
    UNION ALL SELECT 'd2_eligibilities', count(*)::text FROM bowler_occurrence_eligibilities WHERE league_id = ${leagueId}
    UNION ALL SELECT 'd2_assignments', count(*)::text FROM bowler_occurrence_team_assignments WHERE league_id = ${leagueId}
    UNION ALL SELECT 'd2_obligations', count(*)::text FROM bowler_occurrence_obligations WHERE league_id = ${leagueId}
    UNION ALL SELECT 'd2_plans', count(*)::text FROM occurrence_collection_plans WHERE league_id = ${leagueId}
    UNION ALL SELECT 'd2_allocations', count(*)::text FROM payment_occurrence_allocations WHERE league_id = ${leagueId}
    UNION ALL SELECT 'payment_schedules', count(*)::text FROM payment_schedules WHERE league_id = ${leagueId}
    UNION ALL SELECT 'payments', count(*)::text FROM payments WHERE league_id = ${leagueId}
  `);
  return Object.fromEntries(result.rows.map((row) => [row.name, row.value]));
}

let primary: Fixture;
let other: Fixture;
let systemAdmin: AuthSession;

beforeAll(async () => {
  primary = await fixture("primary");
  other = await fixture("other");
  systemAdmin = await login(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD);
});

afterAll(async () => {
  for (const organizationId of organizationsToDelete.splice(0)) {
    await deleteOrganization(organizationId).catch(() => undefined);
  }
});

describe("E1 league occurrence schedule API", () => {
  it("authenticates, enforces roster visibility and tenant scope, and requires explicit system-admin organization selection", async () => {
    const unauthenticated = await apiGet(`/api/leagues/${primary.leagueId}/occurrence-schedule`);
    expect(unauthenticated.status).toBe(401);

    const member = await apiGet<LeagueOccurrenceScheduleReadContract>(
      `/api/leagues/${primary.leagueId}/occurrence-schedule`,
      primary.member,
    );
    expect(member.status).toBe(200);
    expect(member.data.data).toMatchObject({
      organizationId: primary.organizationId,
      leagueId: primary.leagueId,
      authoritativeSource: "legacy_fallback",
      administrator: null,
    });

    const unrostered = await apiGet(`/api/leagues/${primary.leagueId}/occurrence-schedule`, primary.unrostered);
    expect(unrostered.status).toBe(404);
    expect(unrostered.data.error?.code).toBe("NOT_FOUND");

    const crossTenant = await apiGet(`/api/leagues/${other.leagueId}/occurrence-schedule`, primary.admin);
    expect(crossTenant.status).toBe(404);
    expect(JSON.stringify(crossTenant.data)).not.toContain(other.organizationId.toString());

    const missingSystemScope = await apiGet(`/api/leagues/${primary.leagueId}/occurrence-schedule`, systemAdmin);
    expect(missingSystemScope.status).toBe(400);
    expect(missingSystemScope.data.error?.code).toBe("INVALID_REQUEST");
    const scopedSystem = await apiGet<LeagueOccurrenceScheduleReadContract>(
      `/api/leagues/${primary.leagueId}/occurrence-schedule?organizationId=${primary.organizationId}`,
      systemAdmin,
    );
    expect(scopedSystem.status).toBe(200);
    expect(scopedSystem.data.data?.administrator).not.toBeNull();
  });

  it("exposes contextual Fall recovery, keeps draft-only state non-operational, then consumes the approved canonical set", async () => {
    const initial = await apiGet<LeagueOccurrenceScheduleReadContract>(
      `/api/leagues/${primary.leagueId}/occurrence-schedule`,
      primary.admin,
    );
    expect(initial.data.data).toMatchObject({
      contractVersion: "league-occurrence-schedule/1",
      authoritativeSource: "legacy_fallback",
      operationalCanonicalStateExists: false,
      administrator: { fallRecoveryEligible: true, c2ReviewAvailable: false },
    });

    const previewResponse = await apiPost<FallDraftPreview>(
      `/api/leagues/${primary.leagueId}/canonical-fall-drafts/preview`,
      { contractVersion: "fall-draft-preview-request/3" },
      primary.admin,
    );
    const preview = previewResponse.data.data;
    if (!preview) throw new Error("E1 C1 preview was not returned");
    const applied = await apiPost(
      `/api/leagues/${primary.leagueId}/canonical-fall-drafts/apply`,
      {
        contractVersion: "fall-draft-apply-request/3",
        confirmedPreviewFingerprint: preview.previewFingerprint,
        reason: "Create E1 contextual recovery draft",
        idempotencyKey: `e1-draft-${primary.leagueId}`,
      },
      primary.admin,
    );
    expect(applied.status).toBe(201);

    const draftOnly = await apiGet<LeagueOccurrenceScheduleReadContract>(
      `/api/leagues/${primary.leagueId}/occurrence-schedule`,
      primary.admin,
    );
    expect(draftOnly.data.data).toMatchObject({
      authoritativeSource: "legacy_fallback",
      operationalCanonicalStateExists: false,
      administrator: { hasDraftEvidence: true, c2ReviewAvailable: true, fallRecoveryEligible: false },
    });
    expect(draftOnly.data.data?.occurrences.every((row) => row.occurrenceId === null)).toBe(true);

    const reviewResponse = await apiGet<FallDraftReview>(
      `/api/leagues/${primary.leagueId}/canonical-fall-drafts/review`,
      primary.admin,
    );
    const review = reviewResponse.data.data;
    if (!review) throw new Error("E1 C2 review was not returned");
    const approved = await apiPost(
      `/api/leagues/${primary.leagueId}/canonical-fall-drafts/review/approve`,
      {
        contractVersion: "fall-draft-approve-request/1",
        confirmedReviewFingerprint: review.reviewFingerprint,
        reason: "Approve E1 canonical schedule",
        idempotencyKey: `e1-approve-${primary.leagueId}`,
        discrepancyDispositions: [],
      },
      primary.admin,
    );
    expect(approved.status).toBe(201);

    const beforeRead = await writeSnapshot(primary.leagueId);
    const canonicalRead = await apiGet<LeagueOccurrenceScheduleReadContract>(
      `/api/leagues/${primary.leagueId}/occurrence-schedule`,
      primary.admin,
    );
    const afterRead = await writeSnapshot(primary.leagueId);
    expect(canonicalRead.status).toBe(200);
    expect(canonicalRead.data.data).toMatchObject({
      authoritativeSource: "canonical",
      operationalCanonicalStateExists: true,
    });
    expect(canonicalRead.data.data?.occurrences).toHaveLength(3);
    expect(canonicalRead.data.data?.occurrences.find((row) => row.status === "cancelled")).toMatchObject({
      occurrenceId: expect.any(String),
      plannedOrdinal: 2,
      competitionNumber: null,
    });
    expect(canonicalRead.data.data?.skippedDates).toEqual([
      expect.objectContaining({ localDate: "2032-08-08", durableCanonicalException: true }),
    ]);
    expect(canonicalRead.data.data?.occurrences.some((row) => row.authoritativeLocalDate === "2032-08-08")).toBe(false);
    expect(afterRead).toEqual(beforeRead);
  });
});
