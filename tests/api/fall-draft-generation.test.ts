import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { leagues, locations, organizations, users } from "@shared/schema";
import type { FallDraftApplyResult, FallDraftPersistedView, FallDraftPreview } from "@shared/fall-draft-generation";
import type { FallDraftMutationResult, FallDraftReview } from "@shared/fall-draft-review";
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
  contractVersion: "fall-draft-preview-request/2",
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
    expect(previewResponse.data).toMatchObject({
      success: true,
      data: {
        previewContractVersion: "fall-draft-generation-preview/2",
        semantics: { paymentMode: "weekly", regularSessionBillingPolicy: "eligible_bowlers" },
      },
    });
    const preview = previewResponse.data.data as FallDraftPreview;
    const applyResponse = await apiPost<FallDraftApplyResult>(`/api/leagues/${primary.leagueId}/canonical-fall-drafts/apply`, {
      contractVersion: "fall-draft-apply-request/2",
      billingOrdinalPolicy: "planned_slot",
      confirmedPreviewFingerprint: preview.previewFingerprint,
      reason: "C1 API reviewed draft creation",
      idempotencyKey: `c1-api-${primary.leagueId}`,
    }, primary.admin);
    expect(applyResponse.status).toBe(201);
    expect(applyResponse.data.data).toMatchObject({ mode: "applied", writesPerformed: true, relationshipsCreated: false });

    const retryResponse = await apiPost<FallDraftApplyResult>(`/api/leagues/${primary.leagueId}/canonical-fall-drafts/apply`, {
      contractVersion: "fall-draft-apply-request/2",
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

    const foldOverride = await apiPost(`/api/leagues/${other.leagueId}/canonical-fall-drafts/preview`, {
      ...previewBody,
      ambiguousFold: "later",
    }, other.admin);
    expect(foldOverride.status).toBe(400);
    expect(foldOverride.data.error?.code).toBe("VALIDATION_ERROR");

    const currencyOverride = await apiPost(`/api/leagues/${other.leagueId}/canonical-fall-drafts/preview`, {
      ...previewBody,
      currency: "CAD",
    }, other.admin);
    expect(currencyOverride.status).toBe(400);
    expect(currencyOverride.data.error?.code).toBe("VALIDATION_ERROR");

    const billingOverride = await apiPost(`/api/leagues/${other.leagueId}/canonical-fall-drafts/preview`, {
      ...previewBody,
      regularSessionBillingPolicy: "none",
    }, other.admin);
    expect(billingOverride.status).toBe(400);
    expect(billingOverride.data.error?.code).toBe("VALIDATION_ERROR");
  });

  it("provides authenticated C2 review, stale protection, publication, and published-future cancellation", async () => {
    const path = `/api/leagues/${primary.leagueId}/canonical-fall-drafts/review`;
    const normal = await apiGet(path, primary.user);
    expect(normal.status).toBe(403);
    const crossTenant = await apiGet(`/api/leagues/${primary.leagueId}/canonical-fall-drafts/review`, other.admin);
    expect(crossTenant.status).toBe(404);
    expect(JSON.stringify(crossTenant.data)).not.toContain(primary.organizationId.toString());
    const systemMissingScope = await apiGet(path, systemAdmin);
    expect(systemMissingScope.status).toBe(400);
    const systemReview = await apiGet<FallDraftReview>(`${path}?organizationId=${primary.organizationId}`, systemAdmin);
    expect(systemReview.status).toBe(200);
    expect(systemReview.data.data).toMatchObject({
      reviewContractVersion: "fall-draft-review/2",
      generationRun: { state: "generated" },
      c1: { paymentMode: "weekly" },
    });

    const reviewResponse = await apiGet<FallDraftReview>(path, primary.admin);
    const review = reviewResponse.data.data as FallDraftReview;
    const stale = await apiPost(`${path}/cancel`, {
      contractVersion: "fall-draft-cancel-request/1",
      confirmedReviewFingerprint: "0".repeat(64),
      reason: "Reject stale API confirmation",
      idempotencyKey: `c2-api-stale-${primary.leagueId}`,
      occurrenceId: review.occurrences[0].id,
      expectedOccurrenceRevision: review.occurrences[0].currentRevision,
    }, primary.admin);
    expect(stale.status).toBe(409);
    expect(stale.data.error?.code).toBe("FALL_DRAFT_STALE_REVIEW");

    const noCsrf = await fetch(`${BASE_URL}${path}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: primary.admin.cookies },
      body: JSON.stringify({
        contractVersion: "fall-draft-approve-request/1",
        confirmedReviewFingerprint: review.reviewFingerprint,
        reason: "Approve complete C2 API review",
        idempotencyKey: `c2-api-approve-no-csrf-${primary.leagueId}`,
        discrepancyDispositions: [],
      }),
    });
    expect(noCsrf.status).toBe(403);

    const approved = await apiPost<FallDraftMutationResult>(`${path}/approve`, {
      contractVersion: "fall-draft-approve-request/1",
      confirmedReviewFingerprint: review.reviewFingerprint,
      reason: "Approve complete C2 API review",
      idempotencyKey: `c2-api-approve-${primary.leagueId}`,
      discrepancyDispositions: [],
    }, primary.admin);
    expect(approved.status).toBe(201);
    expect(approved.data.data).toMatchObject({ operation: "approve_publish", mode: "applied", review: { generationRun: { state: "applied" } } });
    const published = approved.data.data as FallDraftMutationResult;
    const scheduled = published.review.occurrences.find((row) => row.status === "scheduled");
    if (!scheduled) throw new Error("C2 API published fixture has no scheduled occurrence");
    const cancelled = await apiPost<FallDraftMutationResult>(`${path}/cancel`, {
      contractVersion: "fall-draft-cancel-request/1",
      confirmedReviewFingerprint: published.review.reviewFingerprint,
      reason: "Cancel one published future occurrence through C2 API",
      idempotencyKey: `c2-api-published-cancel-${primary.leagueId}`,
      occurrenceId: scheduled.id,
      expectedOccurrenceRevision: scheduled.currentRevision,
    }, primary.admin);
    expect(cancelled.status).toBe(201);
    expect(cancelled.data.data?.review.occurrences.find((row) => row.id === scheduled.id)).toMatchObject({
      id: scheduled.id, generationKey: scheduled.generationKey, lifecycle: "published", status: "cancelled",
    });
    const transitionedStatus = await apiGet<FallDraftPersistedView>(
      `/api/leagues/${primary.leagueId}/canonical-fall-drafts`,
      primary.admin,
    );
    expect(transitionedStatus.data.data).toMatchObject({
      found: true,
      result: null,
      transitionedToC2: true,
      generationRunId: review.generationRun.id,
    });
  });
});
