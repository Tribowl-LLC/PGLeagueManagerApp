import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { leagues, locations, organizations, users } from "@shared/schema";
import type { FallDraftApplyResult, FallDraftPersistedView, FallDraftPreview } from "@shared/fall-draft-generation";
import { hashPassword } from "../../server/lib/password";
import { deleteOrganization } from "../../server/storage/organizations";
import {
  BASE_URL,
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
const password = "C1-api-local-password-1!";
const previewBody = {
  contractVersion: "fall-draft-preview-request/1",
  ambiguousFold: "reject",
  currency: "USD",
  regularSessionBillingPolicy: "eligible_bowlers",
  billingOrdinalPolicy: "planned_slot",
};

interface ApiFixture {
  organizationId: number;
  leagueId: number;
  admin: AuthSession;
  user: AuthSession;
}

const organizationsToDelete: number[] = [];

async function fixture(label: string): Promise<ApiFixture> {
  const [organization] = await db.insert(organizations).values({ name: `C1 API ${label}`, slug: `c1-api-${label}-${suffix}` }).returning({ id: organizations.id });
  if (!organization) throw new Error("C1 API organization was not created");
  organizationsToDelete.push(organization.id);
  const hashed = await hashPassword(password);
  const adminEmail = `c1-api-${label}-${suffix}@example.test`;
  const userEmail = `c1-api-${label}-${suffix}-user@example.test`;
  await db.insert(users).values([
    { email: adminEmail, password: hashed, name: `C1 API ${label} admin`, role: "org_admin", organizationId: organization.id },
    { email: userEmail, password: hashed, name: `C1 API ${label} user`, role: "user", organizationId: organization.id },
  ]);
  const [location] = await db.insert(locations).values({ name: `C1 API ${label} location`, organizationId: organization.id }).returning({ id: locations.id });
  if (!location) throw new Error("C1 API location was not created");
  const [league] = await db.insert(leagues).values({
    name: `C1 API ${label} league`, organizationId: organization.id, locationId: location.id,
    seasonStart: "2032-08-01", seasonEnd: "2032-08-22", weekDay: "Sunday", timezone: "America/New_York",
    competitionStartTime: "19:00", totalBowlingWeeks: 3, weeklyFee: 2_000,
    skipDates: ["2032-08-08"], cancelledDates: ["2032-08-15"], doublePayDates: ["2032-08-22"],
  }).returning({ id: leagues.id });
  if (!league) throw new Error("C1 API league was not created");
  return { organizationId: organization.id, leagueId: league.id, admin: await login(adminEmail, password), user: await login(userEmail, password) };
}

let primary: ApiFixture;
let other: ApiFixture;
let systemAdmin: AuthSession;

beforeAll(async () => {
  primary = await fixture("primary");
  other = await fixture("other");
  systemAdmin = await login(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD);
});

afterAll(async () => {
  for (const organizationId of organizationsToDelete.splice(0)) await deleteOrganization(organizationId).catch(() => undefined);
});

describe("C1 Fall draft API", () => {
  it("preserves CSRF and response conventions for preview/apply/status", async () => {
    const path = `/api/leagues/${primary.leagueId}/canonical-fall-drafts/preview`;
    const noCsrf = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: primary.admin.cookies },
      body: JSON.stringify(previewBody),
    });
    const noCsrfBody = await noCsrf.json();
    expect(noCsrf.status).toBe(403);
    expect(noCsrfBody).toMatchObject({ success: false, error: { code: "CSRF_ERROR" } });

    const previewResponse = await apiPost<FallDraftPreview>(path, previewBody, primary.admin);
    expect(previewResponse.status).toBe(200);
    expect(previewResponse.data).toMatchObject({ success: true, data: { previewContractVersion: "fall-draft-generation-preview/1" } });
    const preview = previewResponse.data.data as FallDraftPreview;
    const applyResponse = await apiPost<FallDraftApplyResult>(`/api/leagues/${primary.leagueId}/canonical-fall-drafts/apply`, {
      contractVersion: "fall-draft-apply-request/1",
      ambiguousFold: "reject",
      currency: "USD",
      regularSessionBillingPolicy: "eligible_bowlers",
      billingOrdinalPolicy: "planned_slot",
      confirmedPreviewFingerprint: preview.previewFingerprint,
      reason: "C1 API reviewed draft creation",
      idempotencyKey: `c1-api-${primary.leagueId}`,
    }, primary.admin);
    expect(applyResponse.status).toBe(201);
    expect(applyResponse.data.data).toMatchObject({ mode: "applied", writesPerformed: true, relationshipsCreated: false });

    const retryResponse = await apiPost<FallDraftApplyResult>(`/api/leagues/${primary.leagueId}/canonical-fall-drafts/apply`, {
      contractVersion: "fall-draft-apply-request/1",
      ambiguousFold: "reject",
      currency: "USD",
      regularSessionBillingPolicy: "eligible_bowlers",
      billingOrdinalPolicy: "planned_slot",
      confirmedPreviewFingerprint: preview.previewFingerprint,
      reason: "C1 API reviewed draft creation",
      idempotencyKey: `c1-api-${primary.leagueId}`,
    }, primary.admin);
    expect(retryResponse.status).toBe(200);
    expect(retryResponse.data.data?.mode).toBe("idempotent_retry");
    expect(retryResponse.data.data?.durableIds).toEqual(applyResponse.data.data?.durableIds);

    const status = await apiGet<FallDraftPersistedView>(`/api/leagues/${primary.leagueId}/canonical-fall-drafts`, primary.admin);
    expect(status.status).toBe(200);
    expect(status.data.data).toMatchObject({ found: true, currentLegacyScheduleMatchesGenerationInput: true });
  });

  it("allows explicit system-admin scope and fails closed for ordinary and cross-tenant callers", async () => {
    const systemMissingScope = await apiPost(`/api/leagues/${other.leagueId}/canonical-fall-drafts/preview`, previewBody, systemAdmin);
    expect(systemMissingScope.status).toBe(400);
    expect(systemMissingScope.data.error?.code).toBe("INVALID_REQUEST");

    const systemPreview = await apiPost<FallDraftPreview>(
      `/api/leagues/${other.leagueId}/canonical-fall-drafts/preview?organizationId=${other.organizationId}`,
      previewBody,
      systemAdmin,
    );
    expect(systemPreview.status).toBe(200);
    expect(systemPreview.data.data?.operatorScope.organizationId).toBe(other.organizationId);

    const normal = await apiPost(`/api/leagues/${other.leagueId}/canonical-fall-drafts/preview`, previewBody, other.user);
    expect(normal.status).toBe(403);
    expect(normal.data.error?.code).toBe("FORBIDDEN");

    const crossTenant = await apiPost(`/api/leagues/${other.leagueId}/canonical-fall-drafts/preview`, previewBody, primary.admin);
    expect(crossTenant.status).toBe(404);
    expect(crossTenant.data.error?.code).toBe("LEAGUE_NOT_FOUND");
    expect(JSON.stringify(crossTenant.data)).not.toContain(other.organizationId.toString());
  });

  it("rejects body tenant/candidate claims at the strict request boundary", async () => {
    const result = await apiPost(`/api/leagues/${other.leagueId}/canonical-fall-drafts/preview`, {
      ...previewBody,
      organizationId: other.organizationId,
      occurrenceCandidates: [{ startAt: "2032-01-01T00:00:00.000Z" }],
    }, other.admin);
    expect(result.status).toBe(400);
    expect(result.data.error?.code).toBe("VALIDATION_ERROR");
  });
});
