import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { apiGet, login, type AuthSession } from "../helpers";
import { getTestDb } from "../setup/test-db";
import { hashPassword } from "../../server/lib/password";
import { deleteOrganization } from "../../server/storage/organizations";
import { bowlerLeagues, bowlers, leagues, locations, organizations, teams, users } from "@shared/schema";

const db = getTestDb();
let memberFixture: { organizationId: number; leagueId: number; bowlerId: number; peerBowlerId: number; member: AuthSession; unrostered: AuthSession; peer: AuthSession };

beforeAll(async () => {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const password = "f1-member-password-0123456789";
  const [organization] = await db.insert(organizations).values({ name: `F1 API ${suffix}`, slug: `f1-api-${suffix}` }).returning({ id: organizations.id });
  const [location] = await db.insert(locations).values({ name: `F1 API lanes ${suffix}`, organizationId: organization.id }).returning({ id: locations.id });
  const [league] = await db.insert(leagues).values({ name: `F1 API league ${suffix}`, organizationId: organization.id, locationId: location.id, seasonStart: "2038-01-01", seasonEnd: "2038-03-01", weekDay: "Monday", weeklyFee: 2000 }).returning({ id: leagues.id });
  const [team] = await db.insert(teams).values({ name: `F1 API team ${suffix}`, number: 1, leagueId: league.id }).returning({ id: teams.id });
  const [bowler, peerBowler] = await db.insert(bowlers).values([{ name: `F1 API member ${suffix}`, organizationId: organization.id }, { name: `F1 API peer ${suffix}`, organizationId: organization.id }]).returning({ id: bowlers.id });
  await db.insert(bowlerLeagues).values({ bowlerId: bowler.id, leagueId: league.id, teamId: team.id, active: true });
  await db.insert(bowlerLeagues).values({ bowlerId: peerBowler.id, leagueId: league.id, teamId: team.id, active: true });
  const hashed = await hashPassword(password);
  const [memberUser, unrosteredUser, peerUser] = await db.insert(users).values([
    { email: `f1-member-${suffix}@example.test`, password: hashed, name: "F1 member", role: "user", organizationId: organization.id, bowlerId: bowler.id },
    { email: `f1-unrostered-${suffix}@example.test`, password: hashed, name: "F1 unrostered", role: "user", organizationId: organization.id },
    { email: `f1-peer-${suffix}@example.test`, password: hashed, name: "F1 peer", role: "user", organizationId: organization.id, bowlerId: peerBowler.id },
  ]).returning({ email: users.email });
  memberFixture = { organizationId: organization.id, leagueId: league.id, bowlerId: bowler.id, peerBowlerId: peerBowler.id, member: await login(memberUser.email, password), unrostered: await login(unrosteredUser.email, password), peer: await login(peerUser.email, password) };
});

afterAll(async () => { if (memberFixture?.organizationId) await deleteOrganization(memberFixture.organizationId).catch(() => undefined); });

describe("F1 financial API boundary", () => {
  it("rejects array/object scope values without disclosing tenant data", async () => {
    const session = await login(process.env.TEST_ORG_A_EMAIL ?? "testadmin@example.com", process.env.TEST_ORG_PASSWORD ?? "org-local-dev");
    const result = await apiGet("/api/financials/due-past-due?organizationId[]=1", session);
    expect(result.status).toBe(400);
    expect(result.data.error?.code).toBe("INVALID_SCOPE");
    expect(JSON.stringify(result.data)).not.toMatch(/bowl|email|provider|payment/i);
  });

  it("keeps activation dormant with a generic conflict and no provider-facing response", async () => {
    const session = await login(process.env.TEST_ORG_A_EMAIL ?? "testadmin@example.com", process.env.TEST_ORG_PASSWORD ?? "org-local-dev");
    const result = await fetch(`${process.env.TEST_BASE_URL}/api/financials/leagues/1/activate?organizationId=1`, {
      method: "POST",
      headers: { Cookie: session.cookies, "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken },
      body: JSON.stringify({ commandKey: ["f1", "api", "dormant"].join("_"), sourceFingerprint: "dormant-source-fixture", payingLineupSize: 3, responsibilities: [] }),
    });
    const body = await result.json() as { error?: { code?: string } };
    expect(result.status).toBe(409);
    expect(body.error?.code).toBe("FINANCIAL_ACTIVATION_UNAVAILABLE");
  });

  it("enforces org-admin and explicit system-admin scope with a typed aggregate envelope", async () => {
    const orgAdmin = await login(process.env.TEST_ORG_A_EMAIL ?? "testadmin@example.com", process.env.TEST_ORG_PASSWORD ?? "org-local-dev");
    const own = await apiGet<{ organizationId: number; orderVersion: string; authoritativeSource: string; leagues: unknown[] }>(`/api/financials/due-past-due?organizationId=${orgAdmin.user.organizationId}`, orgAdmin);
    expect(own.status).toBe(200);
    expect(own.data.data).toMatchObject({ organizationId: orgAdmin.user.organizationId, orderVersion: "due-at,bowler,occurrence,obligation/1", authoritativeSource: "per-league-snapshots" });
    const system = await login(process.env.TEST_ADMIN_EMAIL ?? "admin@example.com", process.env.TEST_ADMIN_PASSWORD ?? "admin-local-dev");
    expect((await apiGet("/api/financials/due-past-due", system)).status).toBe(400);
    const scoped = await apiGet(`/api/financials/due-past-due?organizationId=${orgAdmin.user.organizationId}`, system);
    expect(scoped.status).toBe(200);
    expect((await apiGet("/api/financials/due-past-due?organizationId%5Bfoo%5D=1", orgAdmin)).status).toBe(400);
  });

  it("fails closed for a cross-tenant bowler scope", async () => {
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    const [foreignOrganization] = await db.insert(organizations).values({ name: `F1 foreign ${suffix}`, slug: `f1-foreign-${suffix}` }).returning({ id: organizations.id });
    if (!foreignOrganization) throw new Error("foreign organization fixture failed");
    try {
      const [foreignBowler] = await db.insert(bowlers).values({ name: `F1 foreign bowler ${suffix}`, organizationId: foreignOrganization.id }).returning({ id: bowlers.id });
      if (!foreignBowler) throw new Error("foreign bowler fixture failed");
      const result = await apiGet(`/api/financials/leagues/${memberFixture.leagueId}/due-past-due?bowlerId=${foreignBowler.id}`, memberFixture.member);
      expect(result.status).toBe(404);
    } finally {
      await deleteOrganization(foreignOrganization.id).catch(() => undefined);
    }
  });

  it("keeps ordinary members self-scoped and nondisclosing", async () => {
    const own = await apiGet(`/api/financials/leagues/${memberFixture.leagueId}/due-past-due?bowlerId=${memberFixture.bowlerId}`, memberFixture.member);
    expect(own.status).toBe(200);
    expect((await apiGet(`/api/financials/leagues/${memberFixture.leagueId}/due-past-due?bowlerId=${memberFixture.peerBowlerId}`, memberFixture.member)).status).toBe(404);
    expect((await apiGet(`/api/financials/leagues/${memberFixture.leagueId}/due-past-due`, memberFixture.member)).status).toBe(404);
    expect((await apiGet("/api/financials/due-past-due", memberFixture.member)).status).toBe(404);
    expect((await apiGet(`/api/financials/leagues/${memberFixture.leagueId}/due-past-due?bowlerId=abc`, memberFixture.member)).status).toBe(404);
    expect((await apiGet(`/api/financials/leagues/${memberFixture.leagueId}/due-past-due?bowlerId%5B0%5D=${memberFixture.bowlerId}`, memberFixture.member)).status).toBe(404);
    expect((await apiGet(`/api/financials/leagues/${memberFixture.leagueId}/due-past-due?unknown=1`, memberFixture.member)).status).toBe(404);
    expect((await apiGet(`/api/financials/leagues/${memberFixture.leagueId}/due-past-due?bowlerId=${memberFixture.bowlerId}`, memberFixture.unrostered)).status).toBe(404);
    await db.update(bowlerLeagues).set({ active: false }).where(eq(bowlerLeagues.bowlerId, memberFixture.bowlerId));
    expect((await apiGet(`/api/financials/leagues/${memberFixture.leagueId}/due-past-due?bowlerId=${memberFixture.bowlerId}`, memberFixture.member)).status).toBe(404);
  });

  it("requires exact organization scope for system-admin league reads", async () => {
    const system = await login(process.env.TEST_ADMIN_EMAIL ?? "admin@example.com", process.env.TEST_ADMIN_PASSWORD ?? "admin-local-dev");
    expect((await apiGet(`/api/financials/leagues/${memberFixture.leagueId}/due-past-due?organizationId=999999`, system)).status).toBe(404);
    expect((await apiGet(`/api/financials/leagues/${memberFixture.leagueId}/due-past-due`, system)).status).toBe(400);
  });
});
