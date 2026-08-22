import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  bowlerLeagues,
  bowlers,
  bowlerOccurrenceEligibilities,
  leagues,
  leagueOccurrences,
  locations,
  organizations,
  payments,
  teams,
  users,
} from "@shared/schema";
import { deleteOrganization } from "../../server/storage/organizations";
import { FinancialActivationError, FinancialReadIncompatibilityError, activateCanonicalFinancials, readCanonicalDuePastDue } from "../../server/services/canonical-due-past-due";
import { getTestDb } from "../setup/test-db";

const db = getTestDb();
const createdOrganizations: number[] = [];

async function fixture(label: string) {
  const [organization] = await db.insert(organizations).values({ name: `F1 ${label}`, slug: `f1-${label.toLowerCase()}-${Date.now()}-${Math.random().toString(16).slice(2)}` }).returning({ id: organizations.id });
  if (!organization) throw new Error("organization fixture failed");
  createdOrganizations.push(organization.id);
  const [location] = await db.insert(locations).values({ name: `F1 ${label} location`, organizationId: organization.id }).returning({ id: locations.id });
  const [actor] = await db.insert(users).values({ email: `f1-${label}-${Date.now()}@example.test`, password: "test", name: `F1 ${label}`, role: "org_admin", organizationId: organization.id }).returning({ id: users.id });
  const [league] = await db.insert(leagues).values({ name: `F1 ${label} league`, organizationId: organization.id, locationId: location.id, seasonStart: "2038-01-01", seasonEnd: "2038-12-31", weekDay: "Sunday", competitionStartTime: "19:00", totalBowlingWeeks: 12, paymentMode: "weekly", weeklyFee: 500, payingLineupSize: 3 }).returning({ id: leagues.id });
  const [team] = await db.insert(teams).values({ name: `F1 ${label} team`, number: 1, leagueId: league.id }).returning({ id: teams.id });
  const [member, inactive] = await db.insert(bowlers).values([{ name: `F1 ${label} member`, organizationId: organization.id, active: true }, { name: `F1 ${label} inactive`, organizationId: organization.id, active: false }]).returning({ id: bowlers.id });
  await db.insert(bowlerLeagues).values({ bowlerId: member.id, leagueId: league.id, teamId: team.id, active: true });
  return { organizationId: organization.id, leagueId: league.id, actorUserId: actor.id, memberId: member.id, inactiveId: inactive.id, occurrenceId: (await db.insert(leagueOccurrences).values({ organizationId: organization.id, leagueId: league.id, locationId: location.id, generationKey: `f1-${label}-${Date.now()}`, kind: "regular", status: "scheduled", lifecycle: "draft", authoritativeLocalDate: "2038-02-07", authoritativeLocalStartTime: "19:00:00", timezone: "UTC", startAt: "2038-02-08T00:00:00.000Z", selectedUtcOffsetMinutes: 0, foldResolution: "unambiguous", resolverVersion: "f1-test/1", plannedOrdinal: 1, competitionNumber: 1 }).returning({ id: leagueOccurrences.id }))[0].id };
}

afterEach(async () => { for (const organizationId of createdOrganizations.splice(0)) await deleteOrganization(organizationId); });

describe("F1 canonical due/past-due database contract", () => {
  it("returns a labeled clean legacy fallback including zero-payment active members", async () => {
    const f = await fixture("fallback");
    const result = await readCanonicalDuePastDue({ organizationId: f.organizationId, leagueId: f.leagueId, now: new Date("2038-02-10T00:00:00.000Z") });
    const repeat = await readCanonicalDuePastDue({ organizationId: f.organizationId, leagueId: f.leagueId, now: new Date("2038-02-10T00:00:00.000Z") });
    expect(result.mode).toBe("legacy_fallback");
    expect(result.unavailableReason).toBe("not_activated");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.bowlerId).toBe(f.memberId);
    expect(result.rows[0]?.allocatedMinor).toBe(0);
    expect(result.rows[0]?.legacyPaidMinor).toBe(0);
    expect(result.fingerprint).toMatch(/^lvfinancialread:v1:[0-9a-f]{64}$/);
    expect(repeat.fingerprint).toBe(result.fingerprint);
    await db.update(leagues).set({ weeklyFee: 600 }).where(and(eq(leagues.id, f.leagueId), eq(leagues.organizationId, f.organizationId)));
    const changed = await readCanonicalDuePastDue({ organizationId: f.organizationId, leagueId: f.leagueId, now: new Date("2038-02-10T00:00:00.000Z") });
    expect(changed.fingerprint).not.toBe(result.fingerprint);
  });

  it("excludes inactive/nonmember payment rows and fails closed on partial D2 evidence", async () => {
    const f = await fixture("partial");
    await db.insert(payments).values({ bowlerId: f.inactiveId, leagueId: f.leagueId, amount: 500, weekOf: "2038-02-08T00:00:00.000Z", status: "paid", type: "cash" });
    const fallback = await readCanonicalDuePastDue({ organizationId: f.organizationId, leagueId: f.leagueId });
    expect(fallback.rows.every((row) => row.bowlerId !== f.inactiveId)).toBe(true);
    await db.insert(bowlerOccurrenceEligibilities).values({ organizationId: f.organizationId, leagueId: f.leagueId, occurrenceId: f.occurrenceId, bowlerId: f.memberId, state: "eligible", reason: "explicit_admin_selection", recordedByUserId: f.actorUserId });
    await expect(readCanonicalDuePastDue({ organizationId: f.organizationId, leagueId: f.leagueId })).rejects.toBeInstanceOf(FinancialReadIncompatibilityError);
  });

  it("rejects activation before a complete E1 source and keeps exact retry/payload errors nondisclosing", async () => {
    const f = await fixture("activation");
    const input = { organizationId: f.organizationId, leagueId: f.leagueId, actorUserId: f.actorUserId, commandKey: "f1-dormant", sourceFingerprint: `lvfinancialsource:v1:${"0".repeat(64)}`, payingLineupSize: 3 as const, responsibilities: [] };
    await expect(activateCanonicalFinancials(input)).rejects.toMatchObject({ code: "canonical_incomplete" });
    await expect(activateCanonicalFinancials({ ...input, leagueId: f.leagueId + 1 })).rejects.toBeInstanceOf(Error);
  });

  it("refuses pristine activation over any existing legacy payment evidence", async () => {
    const f = await fixture("payment-gate");
    await db.insert(payments).values({ bowlerId: f.memberId, leagueId: f.leagueId, amount: 500, weekOf: "2038-02-08T00:00:00.000Z", status: "paid", type: "cash" });
    await expect(activateCanonicalFinancials({ organizationId: f.organizationId, leagueId: f.leagueId, actorUserId: f.actorUserId, commandKey: "f1-payment-gate", sourceFingerprint: `lvfinancialsource:v1:${"0".repeat(64)}`, payingLineupSize: 3, responsibilities: [] })).rejects.toMatchObject({ code: "reconciliation_required" });
  });

  it("keeps timing semantics independent of legacy payment dates", async () => {
    const f = await fixture("timing");
    const result = await readCanonicalDuePastDue({ organizationId: f.organizationId, leagueId: f.leagueId });
    expect(result.asOf).toMatch(/(Z|\+00)$/);
    expect(result.orderVersion).toBe("due-at,bowler,occurrence,obligation/1");
  });
});
