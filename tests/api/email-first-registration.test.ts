/**
 * API/transaction coverage for email-first public registration.
 *
 * This file intentionally uses the per-worker app and database provisioned by
 * tests/setup/per-worker-setup.ts. That app starts with background workers
 * suppressed; setup actions are issued directly through the local storage
 * function below, so no provider call is made by this suite.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";

import { db } from "../../server/db";
import { hashPassword } from "../../server/lib/password";
import { storage } from "../../server/storage";
import {
  accountActionDeliveryJobs,
  accountActionRequests,
  bowlers,
  leagues,
  users,
} from "@shared/schema";
import {
  consumeAccountActionAndSetPassword,
  tryIssueAccountRegistration,
  type AccountRegistrationIssuanceResult,
} from "../../server/storage/account-action-requests";
import * as identityLink from "../../server/services/identity-link.js";
import {
  BASE_URL,
  getBaselineOrgAId,
  getBaselineOrgIds,
} from "../helpers";

const REGISTRATION_ACTION = "account_registration";
const PASSWORD_FOR_SETUP = "RegistrationSetup9!";
const API_ORG_SLUG = process.env.TEST_ORG_A_SLUG ?? "vitest-org-a";
const OTHER_ORG_SLUG = process.env.TEST_ORG_B_SLUG ?? "vitest-org-b";

let organizationId: number;
let otherOrganizationId: number;
let publicLeagueId: number;
let emailSequence = 0;
const createdUserIds: number[] = [];
const createdBowlerIds: number[] = [];

type JsonObject = {
  success?: boolean;
  data?: Record<string, unknown>;
  error?: { code?: string; message?: string; [key: string]: unknown };
  [key: string]: unknown;
};

function uniqueEmail(label: string): string {
  emailSequence += 1;
  return `registration-${label}-${Date.now()}-${emailSequence}@vitest.local`;
}

function registrationPath(path: string, slug = API_ORG_SLUG): string {
  const joiner = path.includes("?") ? "&" : "?";
  return `${path}${joiner}__org_slug=${encodeURIComponent(slug)}`;
}

function cookiesFrom(response: Response): string {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const values = headers.getSetCookie?.() ?? [];
  return values.map((value) => value.split(";", 1)[0]).join("; ");
}

async function requestJson(
  path: string,
  init: RequestInit = {},
  cookie?: string,
): Promise<{ response: Response; body: JsonObject }> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  headers.set("x-test-rate-limit-bypass", "1");
  if (cookie) headers.set("Cookie", cookie);

  const response = await fetch(`${BASE_URL}${path}`, { ...init, headers });
  return { response, body: await response.json() as JsonObject };
}

async function register(input: {
  email: string;
  name?: string;
  phone?: string;
}): Promise<{ response: Response; body: JsonObject; cookies: string }> {
  const result = await requestJson(registrationPath("/api/auth/register"), {
    method: "POST",
    body: JSON.stringify({
      email: input.email,
      name: input.name ?? "Email First Test User",
      phone: input.phone ?? "555-101-0101",
      leagueId: publicLeagueId,
      organizationId,
    }),
  });
  return { ...result, cookies: cookiesFrom(result.response) };
}

async function setPassword(token: string): Promise<{ response: Response; body: JsonObject; cookies: string }> {
  const result = await requestJson("/api/auth/set-password", {
    method: "POST",
    body: JSON.stringify({ token, password: PASSWORD_FOR_SETUP }),
  });
  return { ...result, cookies: cookiesFrom(result.response) };
}

async function userRow(userId: number): Promise<typeof users.$inferSelect> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new Error(`User ${userId} was not found`);
  return user;
}

async function userByEmail(email: string, scopedOrganizationId = organizationId): Promise<typeof users.$inferSelect> {
  const [user] = await db.select().from(users).where(and(
    eq(users.email, email),
    eq(users.organizationId, scopedOrganizationId),
  )).limit(1);
  if (!user) throw new Error(`User ${email} was not created`);
  return user;
}

async function countRegistrationActions(userId: number): Promise<number> {
  const rows = await db
    .select({ id: accountActionRequests.id })
    .from(accountActionRequests)
    .where(and(
      eq(accountActionRequests.userId, userId),
      sql`${accountActionRequests.action} = ${REGISTRATION_ACTION}`,
    ));
  return rows.length;
}

async function countRegistrationJobs(userId: number): Promise<number> {
  const rows = await db
    .select({ id: accountActionDeliveryJobs.id })
    .from(accountActionDeliveryJobs)
    .where(and(
      eq(accountActionDeliveryJobs.userId, userId),
      sql`${accountActionDeliveryJobs.action} = ${REGISTRATION_ACTION}`,
    ));
  return rows.length;
}

type RegistrationIssuerInput = Parameters<typeof tryIssueAccountRegistration>[0];
type IssuedRegistrationAction = Extract<AccountRegistrationIssuanceResult, { kind: "issued" }>;

/**
 * Issue only the bearer action in-process. There is no worker/provider in
 * this path; the durable job is inserted first to model the queue origin.
 */
async function issueRegistrationAction(input: RegistrationIssuerInput): Promise<IssuedRegistrationAction> {
  const result = await tryIssueAccountRegistration(input);
  if (result.kind !== "issued") {
    throw new Error(`Registration action was not issued: ${result.reason}`);
  }
  return { kind: "issued", token: result.token, request: result.request };
}

async function createPendingRegistration(input: {
  email?: string;
  bowlerId?: number | null;
  name?: string;
  organizationId?: number;
} = {}): Promise<{
  user: typeof users.$inferSelect;
  job: typeof accountActionDeliveryJobs.$inferSelect;
  action: IssuedRegistrationAction;
}> {
  const email = input.email ?? uniqueEmail("direct");
  const registrationOrganizationId = input.organizationId ?? organizationId;
  const placeholder = await hashPassword(randomBytes(32).toString("hex"));
  const user = await storage.createUser({
    email,
    name: input.name ?? "Pending Direct Registration",
    phone: "555-202-0202",
    password: placeholder,
    role: "user",
    organizationId: registrationOrganizationId,
    bowlerId: input.bowlerId ?? null,
  });
  createdUserIds.push(user.id);

  const [job] = await db.insert(accountActionDeliveryJobs).values({
    userId: user.id,
    organizationId: registrationOrganizationId,
    action: REGISTRATION_ACTION,
    credentialGeneration: user.credentialGeneration,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  }).returning();
  if (!job) throw new Error("Registration delivery job was not created");

  const action = await issueRegistrationAction({
    userId: user.id,
    organizationId: registrationOrganizationId,
    recipientEmail: email,
    deliveryJobId: job.id,
    expectedCredentialGeneration: user.credentialGeneration,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  });
  return { user, job, action };
}

async function createBowler(input: {
  email: string;
  name?: string;
  phone?: string;
}): Promise<typeof bowlers.$inferSelect> {
  const [bowler] = await db.insert(bowlers).values({
    email: input.email,
    name: input.name ?? "Roster-only profile",
    phone: input.phone ?? "555-303-0303",
    organizationId,
  }).returning();
  if (!bowler) throw new Error("Bowler was not created");
  createdBowlerIds.push(bowler.id);
  return bowler;
}

beforeAll(async () => {
  organizationId = await getBaselineOrgAId();
  ({ orgBId: otherOrganizationId } = await getBaselineOrgIds());

  const [league] = await db.insert(leagues).values({
    name: `Email-first API fixture ${Date.now()}`,
    organizationId,
    active: true,
    allowPublicSignup: true,
    seasonStart: "2030-01-07",
    seasonEnd: "2030-04-29",
    weekDay: "Monday",
    paymentMode: "weekly",
  }).returning();
  if (!league) throw new Error("Public registration league was not created");
  publicLeagueId = league.id;
});

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.update(users).set({ bowlerId: null }).where(inArray(users.id, createdUserIds));
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  if (createdBowlerIds.length > 0) {
    await db.delete(bowlers).where(inArray(bowlers.id, createdBowlerIds));
  }
  if (publicLeagueId) {
    await db.delete(leagues).where(eq(leagues.id, publicLeagueId));
  }
});

describe("email-first registration API", () => {
  it("returns 202 without authenticating and exposes session-scoped status before action issuance", async () => {
    const email = uniqueEmail("session");
    const started = await register({ email });
    expect(started.response.status).toBe(202);
    expect(started.body).toMatchObject({ success: true, data: { status: "pending" } });
    expect(started.body.data?.email).toEqual(expect.stringContaining("@vitest.local"));
    expect(started.cookies).toContain("connect.sid=");

    const user = await userByEmail(email);
    expect(user.password).toEqual(expect.any(String));
    expect(user.password.length).toBeGreaterThan(0);
    expect(user.bowlerId).toBeNull();
    createdUserIds.push(user.id);

    const placeholderLogin = await requestJson("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password: "NotTheGeneratedPassword9!" }),
    });
    expect(placeholderLogin.response.status).toBe(401);

    const beforeSetup = await requestJson("/api/auth/user", {}, started.cookies);
    expect(beforeSetup.response.status).toBe(401);

    // The job is durable before its worker mints a bearer action. This is the
    // queued-before-action state, and status must not leak a token.
    expect(await countRegistrationActions(user.id)).toBe(0);
    expect(await countRegistrationJobs(user.id)).toBe(1);
    const status = await requestJson(registrationPath("/api/auth/registration/status"), {}, started.cookies);
    expect(status.response.status).toBe(200);
    expect(status.body.data).toMatchObject({ status: "pending", actionStatus: "pending", deliveryStatus: "not_attempted" });
    expect(JSON.stringify(status.body)).not.toContain("token");

    // A second browser (or a request without the registration cookie) has no
    // capability. Tenant context is part of the capability boundary too.
    const otherBrowser = await requestJson(registrationPath("/api/auth/registration/status"));
    expect(otherBrowser.response.status).toBe(404);
    const wrongTenant = await requestJson(registrationPath("/api/auth/registration/status", OTHER_ORG_SLUG), {}, started.cookies);
    expect(wrongTenant.response.status).toBe(404);

    const noCookieResend = await requestJson(registrationPath("/api/auth/registration/resend"), { method: "POST", body: "{}" });
    expect(noCookieResend.response.status).toBe(403);
    expect(noCookieResend.body.error?.code).toBe("CSRF_ERROR");
    const csrf = await requestJson("/api/csrf-token", {}, started.cookies);
    const csrfToken = typeof csrf.body.data?.token === "string" ? csrf.body.data.token : "";
    expect(csrfToken).toBeTruthy();
    const resend = await requestJson(registrationPath("/api/auth/registration/resend"), {
      method: "POST",
      body: "{}",
      headers: { "x-csrf-token": csrfToken },
    }, started.cookies);
    expect(resend.response.status).toBe(202);
  });

  it("treats a case/trim-normalized duplicate as generic success without mutating the existing account", async () => {
    const email = uniqueEmail("duplicate");
    const first = await register({ email, name: "Original Registration Name", phone: "555-404-0404" });
    expect(first.response.status).toBe(202);
    const before = await userByEmail(email);
    createdUserIds.push(before.id);
    const beforeJobs = await countRegistrationJobs(before.id);
    const beforeActions = await countRegistrationActions(before.id);

    const duplicate = await register({
      email: `  ${email.toUpperCase()}  `,
      name: "Attacker's Replacement Name",
      phone: "555-999-9999",
    });
    expect(duplicate.response.status).toBe(202);
    expect(duplicate.body.data?.status).toBe("pending");

    const after = await userRow(before.id);
    expect({ email: after.email, name: after.name, phone: after.phone, password: after.password, credentialGeneration: after.credentialGeneration })
      .toEqual({ email: before.email, name: before.name, phone: before.phone, password: before.password, credentialGeneration: before.credentialGeneration });
    expect(await countRegistrationJobs(after.id)).toBe(beforeJobs);
    expect(await countRegistrationActions(after.id)).toBe(beforeActions);
  });

  it("resumes a durable pending registration when a fresh browser submits the same email", async () => {
    const email = uniqueEmail("fresh-browser");
    const first = await register({ email, name: "Original Pending Name", phone: "555-404-0404" });
    expect(first.response.status).toBe(202);
    const before = await userByEmail(email);
    createdUserIds.push(before.id);
    const beforeJobs = await countRegistrationJobs(before.id);
    const beforeActions = await countRegistrationActions(before.id);

    // No cookie is sent: this is a new browser recovering the same pending
    // account. The existing profile and placeholder credential remain intact.
    const resumed = await register({
      email: ` ${email.toUpperCase()} `,
      name: "Replacement Name Must Be Ignored",
      phone: "555-9999-9999",
    });
    expect(resumed.response.status).toBe(202);
    expect(resumed.cookies).toContain("connect.sid=");
    expect(await countRegistrationJobs(before.id)).toBe(beforeJobs);
    expect(await countRegistrationActions(before.id)).toBe(beforeActions);
    const after = await userRow(before.id);
    expect({ email: after.email, name: after.name, phone: after.phone, password: after.password, bowlerId: after.bowlerId })
      .toEqual({ email: before.email, name: before.name, phone: before.phone, password: before.password, bowlerId: before.bowlerId });

    const status = await requestJson(registrationPath("/api/auth/registration/status"), {}, resumed.cookies);
    expect(status.response.status).toBe(200);
    expect(status.body.data).toMatchObject({ status: "pending", actionStatus: "pending" });
  });

  it("does not revive completed, changed-generation, or cross-tenant accounts", async () => {
    const completed = await createPendingRegistration({ name: "Completed Resume Guard" });
    const completedBeforeJobs = await countRegistrationJobs(completed.user.id);
    const completedBeforeActions = await countRegistrationActions(completed.user.id);
    const completedResult = await setPassword(completed.action.token);
    expect(completedResult.response.status).toBe(200);
    const completedResubmit = await register({ email: completed.user.email });
    expect(completedResubmit.response.status).toBe(202);
    expect(await countRegistrationJobs(completed.user.id)).toBe(completedBeforeJobs);
    expect(await countRegistrationActions(completed.user.id)).toBe(completedBeforeActions);
    const completedStatus = await requestJson(registrationPath("/api/auth/registration/status"), {}, completedResubmit.cookies);
    expect(completedStatus.response.status).toBe(404);

    const changedGeneration = await createPendingRegistration({ name: "Changed Generation Resume Guard" });
    const changedBeforeJobs = await countRegistrationJobs(changedGeneration.user.id);
    await db.update(users).set({ password: await hashPassword("ChangedGeneration9!") })
      .where(eq(users.id, changedGeneration.user.id));
    const changedResubmit = await register({ email: changedGeneration.user.email });
    expect(changedResubmit.response.status).toBe(202);
    expect(await countRegistrationJobs(changedGeneration.user.id)).toBe(changedBeforeJobs);
    const changedStatus = await requestJson(registrationPath("/api/auth/registration/status"), {}, changedResubmit.cookies);
    expect(changedStatus.response.status).toBe(404);

    const crossTenant = await createPendingRegistration({ organizationId: otherOrganizationId, name: "Other Tenant Resume Guard" });
    const crossTenantBeforeJobs = await countRegistrationJobs(crossTenant.user.id);
    const crossTenantResubmit = await register({ email: crossTenant.user.email });
    expect(crossTenantResubmit.response.status).toBe(202);
    expect(await countRegistrationJobs(crossTenant.user.id)).toBe(crossTenantBeforeJobs);
    const crossTenantStatus = await requestJson(registrationPath("/api/auth/registration/status"), {}, crossTenantResubmit.cookies);
    expect(crossTenantStatus.response.status).toBe(404);
  });

  it("creates exactly one user and one matching registration delivery job atomically", async () => {
    const email = uniqueEmail("atomic");
    const started = await register({ email });
    expect(started.response.status).toBe(202);

    const user = await userByEmail(email);
    createdUserIds.push(user.id);
    const [job] = await db
      .select()
      .from(accountActionDeliveryJobs)
      .where(and(eq(accountActionDeliveryJobs.userId, user.id), sql`${accountActionDeliveryJobs.action} = ${REGISTRATION_ACTION}`));
    expect(job).toMatchObject({
      userId: user.id,
      organizationId,
      credentialGeneration: user.credentialGeneration,
      status: "pending",
      attemptCount: 0,
    });
    expect(await countRegistrationJobs(user.id)).toBe(1);
    expect(await countRegistrationActions(user.id)).toBe(0);
  });

  it("consumes a job-associated setup action and links exactly one same-org email match without overwriting roster metadata", async () => {
    const email = uniqueEmail("unique-match");
    const bowler = await createBowler({
      email: `  ${email.toUpperCase()}  `,
      name: "Different Roster Name",
      phone: "555-505-0505",
    });
    const pending = await createPendingRegistration({ email, name: "Different Account Name" });
    expect(pending.action.request.deliveryJobId).toBe(pending.job.id);
    const result = await setPassword(pending.action.token);
    expect(result.response.status).toBe(200);
    expect(result.body.success).toBe(true);

    const after = await userRow(pending.user.id);
    expect(after.bowlerId).toBe(bowler.id);
    const [rosterAfter] = await db.select({ name: bowlers.name, phone: bowlers.phone }).from(bowlers).where(eq(bowlers.id, bowler.id));
    expect(rosterAfter).toEqual({ name: "Different Roster Name", phone: "555-505-0505" });
  });

  it("completes email proof but leaves a no-match account unlinked for administrator setup", async () => {
    const pending = await createPendingRegistration();
    const result = await setPassword(pending.action.token);
    expect(result.response.status).toBe(200);
    expect((await userRow(pending.user.id)).bowlerId).toBeNull();
  });

  it("rolls back password and token consumption when an unexpected identity-link failure occurs", async () => {
    const email = uniqueEmail("link-failure");
    await createBowler({ email, name: "Link Failure Candidate" });
    const pending = await createPendingRegistration({ email });
    const originalPassword = pending.user.password;
    const linkSpy = vi.spyOn(identityLink, "linkUserToBowler")
      .mockRejectedValueOnce(new Error("unexpected identity service outage"));

    try {
      const replacementHash = await hashPassword("LinkFailureRetry9!");
      await expect(consumeAccountActionAndSetPassword({
        token: pending.action.token,
        passwordHash: replacementHash,
      })).rejects.toThrow("unexpected identity service outage");
      const afterFailure = await userRow(pending.user.id);
      expect(afterFailure.password).toBe(originalPassword);
      const [actionAfterFailure] = await db
        .select({ status: accountActionRequests.status })
        .from(accountActionRequests)
        .where(eq(accountActionRequests.id, pending.action.request.id));
      expect(actionAfterFailure?.status).toBe("pending");
    } finally {
      linkSpy.mockRestore();
    }

    const retry = await setPassword(pending.action.token);
    expect(retry.response.status).toBe(200);
    expect((await userRow(pending.user.id)).password).not.toBe(originalPassword);
  });

  it("does not guess when two same-org roster rows normalize to the same email", async () => {
    const email = uniqueEmail("ambiguous");
    await createBowler({ email: ` ${email.toUpperCase()} `, name: "Ambiguous One" });
    await createBowler({ email, name: "Ambiguous Two" });
    const pending = await createPendingRegistration({ email });
    const result = await setPassword(pending.action.token);
    expect(result.response.status).toBe(200);
    expect((await userRow(pending.user.id)).bowlerId).toBeNull();
  });

  it("does not steal a matching bowler already claimed by another account", async () => {
    const email = uniqueEmail("claimed");
    const bowler = await createBowler({ email, name: "Already Claimed Roster" });
    const claimer = await storage.createUser({
      email: uniqueEmail("claimer"),
      name: "Existing Claimer",
      phone: "555-606-0606",
      password: await hashPassword("ExistingClaimer9!"),
      role: "user",
      organizationId,
      bowlerId: bowler.id,
    });
    createdUserIds.push(claimer.id);

    const pending = await createPendingRegistration({ email });
    const result = await setPassword(pending.action.token);
    expect(result.response.status).toBe(200);
    expect((await userRow(pending.user.id)).bowlerId).toBeNull();
    expect((await userRow(claimer.id)).bowlerId).toBe(bowler.id);
  });

  it("preserves an administrator link made after signup but before setup", async () => {
    const email = uniqueEmail("admin-linked");
    const bowler = await createBowler({ email, name: "Admin Linked Before Setup" });
    const pending = await createPendingRegistration({ email });
    await db.update(users).set({ bowlerId: bowler.id }).where(eq(users.id, pending.user.id));
    const result = await setPassword(pending.action.token);
    expect(result.response.status).toBe(200);
    expect((await userRow(pending.user.id)).bowlerId).toBe(bowler.id);
  });

  it("rejects role, organization, and credential-generation drift between issuance and consumption", async () => {
    const drifts: Array<{ label: string; apply: (userId: number) => Promise<void> }> = [
      {
        label: "role",
        apply: async (userId) => {
          await db.update(users).set({ role: "org_admin" }).where(eq(users.id, userId));
        },
      },
      {
        label: "organization",
        apply: async (userId) => {
          await db.update(users).set({ organizationId: otherOrganizationId }).where(eq(users.id, userId));
        },
      },
      {
        label: "credential-generation",
        apply: async (userId) => {
          await db.update(users).set({ password: await hashPassword("GenerationDrift9!") }).where(eq(users.id, userId));
        },
      },
    ];

    for (const drift of drifts) {
      const pending = await createPendingRegistration({ name: `Drift ${drift.label}` });
      await drift.apply(pending.user.id);
      const result = await setPassword(pending.action.token);
      expect(result.response.status, drift.label).toBe(400);
      expect(["INVALID_TOKEN", "TOKEN_REVOKED"], drift.label).toContain(result.body.error?.code);
      const after = await userRow(pending.user.id);
      if (drift.label === "credential-generation") {
        expect(after.password, drift.label).not.toBe(pending.user.password);
      } else {
        expect(after.password, drift.label).toBe(pending.user.password);
      }
    }
  });

  it("allows only one concurrent consumer of a registration token", async () => {
    const pending = await createPendingRegistration();
    const [first, second] = await Promise.all([
      setPassword(pending.action.token),
      setPassword(pending.action.token),
    ]);
    expect([first.response.status, second.response.status].sort()).toEqual([200, 400]);
    const [action] = await db.select({ status: accountActionRequests.status })
      .from(accountActionRequests).where(eq(accountActionRequests.id, pending.action.request.id));
    expect(action?.status).toBe("consumed");
  });
});
