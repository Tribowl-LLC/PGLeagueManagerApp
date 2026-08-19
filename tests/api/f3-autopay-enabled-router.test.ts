import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import express from "express";
import { eq } from "drizzle-orm";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { makeF3WorkflowFixture } from "../helpers/f3-workflow-fixture";
import { getTestDb } from "../setup/test-db";
import { leagues } from "@shared/schema";

// The gate must be enabled before the router/config module graph is loaded.
// This is an actual mounted-router test; the provider boundary is the only
// mocked edge and should remain untouched by provider-free reads/preflights.
const providerFactory = vi.hoisted(() => vi.fn());
vi.hoisted(() => {
  process.env.LEAGUEVAULT_F3_CANONICAL_AUTOPAY_ENABLED = "1";
});
vi.mock("../../server/services/payment-provider-factory", async () => {
  const actual = await vi.importActual<typeof import("../../server/services/payment-provider-factory")>("../../server/services/payment-provider-factory");
  return { ...actual, getPaymentProvider: providerFactory };
});

const router = (await import("../../server/routes/f3-autopay")).default;

type TestUser = { id: number; role: string; organizationId: number | null; bowlerId?: number | null };
let server: Server;
let baseUrl = "";
let fixture: Awaited<ReturnType<typeof makeF3WorkflowFixture>>;
let payerBowlerId: number;
const testDb = getTestDb();

async function request(path: string, init: RequestInit = {}, user?: TestUser) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (user) headers.set("x-test-user", JSON.stringify(user));
  return fetch(`${baseUrl}${path}`, { ...init, headers });
}

function bodyCode(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const error = "error" in body && body.error && typeof body.error === "object" ? body.error : undefined;
  if (error && "code" in error && typeof error.code === "string") return error.code;
  return "code" in body && typeof body.code === "string" ? body.code : undefined;
}

beforeAll(async () => {
  fixture = await makeF3WorkflowFixture();
  payerBowlerId = fixture.roster[0].id;

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const raw = req.header("x-test-user");
    if (!raw) return res.status(401).json({ success: false, error: { code: "UNAUTHORIZED" } });
    try { Object.assign(req, { user: JSON.parse(raw) }); } catch { return res.status(401).json({ success: false, error: { code: "UNAUTHORIZED" } }); }
    return next();
  });
  app.use("/api/financials/f3", router);
  await new Promise<void>((resolve, reject) => { server = app.listen(0, "127.0.0.1", () => resolve()); server.once("error", reject); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

describe("enabled F3 canonical router contract", () => {
  const league = () => ({ id: fixture.leagueId, organizationId: fixture.organizationId, paymentMode: "weekly" });
  const admin = () => ({ id: fixture.actorUserId, role: "org_admin", organizationId: fixture.organizationId });
  const payer = () => ({ id: fixture.actorUserId, role: "bowler", organizationId: fixture.organizationId, bowlerId: payerBowlerId });
  const systemAdmin = () => ({ id: 900003, role: "system_admin", organizationId: null });

  it("requires auth at the mounted boundary and exposes enabled admin candidate behavior", async () => {
    const anonymous = await request(`/api/financials/f3/leagues/${league().id}/policy/candidates`);
    expect(anonymous.status).toBe(401);
    const response = await request(`/api/financials/f3/leagues/${league().id}/policy/candidates`, {}, admin());
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(bodyCode(payload)).not.toBe("F3_DISABLED");
    expect(payload.data.occurrences).toHaveLength(2);
    const policyCreate = await request(`/api/financials/f3/leagues/${league().id}/policy`, { method: "POST", body: JSON.stringify({ activationId: fixture.activationId, activationRevision: 1, activationSourceFingerprint: fixture.activationSourceFingerprint, policyVersion: 1, collectionPoints: [{ occurrenceId: fixture.occurrenceIds[1] }], occurrences: [{ occurrenceId: fixture.occurrenceIds[0], groupKey: "route-double", groupRole: "paired", pairedOccurrenceId: fixture.occurrenceIds[1], collectionPoint: { occurrenceId: fixture.occurrenceIds[1] } }, { occurrenceId: fixture.occurrenceIds[1], groupKey: "route-double", groupRole: "trigger", pairedOccurrenceId: fixture.occurrenceIds[0], collectionPoint: { occurrenceId: fixture.occurrenceIds[1] } }], commandKey: crypto.randomUUID() }) }, admin());
    expect(policyCreate.status).toBe(201);
    const policyId = (await policyCreate.json()).data.id as string;
    const approval = await request(`/api/financials/f3/leagues/${league().id}/policy/${policyId}/approve`, { method: "POST", body: "{}" }, admin());
    expect(approval.status).toBe(200);
  });

  it("keeps policy commands bounded and nondisclosing across tenant and role scopes", async () => {
    const invalid = await request(`/api/financials/f3/leagues/${league().id}/policy`, { method: "POST", body: JSON.stringify({ commandKey: crypto.randomUUID() }) }, admin());
    expect(invalid.status).toBe(400);
    expect(bodyCode(await invalid.json())).toBe("INVALID_POLICY");

    const unknownApproval = await request(`/api/financials/f3/leagues/${league().id}/policy/${crypto.randomUUID()}/approve`, { method: "POST", body: "{}" }, systemAdmin());
    expect([404, 409]).toContain(unknownApproval.status);
    expect(bodyCode(await unknownApproval.json())).not.toBe("F3_DISABLED");
  });

  it("requires payer self-authorization and keeps prequote provider-free", async () => {
    const nonSelf = await request(`/api/financials/f3/leagues/${league().id}/prequote?bowlerId=${payerBowlerId + 999999}`, {}, payer());
    expect(nonSelf.status).toBe(404);
    const prequote = await request(`/api/financials/f3/leagues/${league().id}/prequote?bowlerId=${payerBowlerId}&coveredBowlerIds=${payerBowlerId},${fixture.roster[1].id}`, {}, payer());
    expect(prequote.status).toBe(200);
    const payload = await prequote.json();
    expect(payload.data.items).toHaveLength(4);
    expect(payload.data.groups).toHaveLength(2);
    expect(providerFactory).not.toHaveBeenCalled();

    const policy = payload.data.policy;
    const authorization = payload.data.authorization;
    providerFactory.mockResolvedValue({ providerName: "square", validateCardId: vi.fn().mockReturnValue(true), hasCardOnFile: vi.fn().mockResolvedValue(true) });
    const authorizationBody = { payerBowlerId, policyId: policy.id, policyVersion: policy.version, authorizationVersion: authorization.nextAuthorizationVersion, coveredBowlerIds: authorization.coveredBowlerIds, sourceId: "card-route", collectionPointOccurrenceIds: authorization.collectionPointOccurrenceIds, preauthorizationFingerprint: payload.data.fingerprint, authorizedItems: payload.data.items, commandKey: crypto.randomUUID() };
    const authorized = await request(`/api/financials/f3/leagues/${league().id}/authorize`, { method: "POST", body: JSON.stringify(authorizationBody) }, payer());
    expect(authorized.status).toBe(201);
    const authorizationId = (await authorized.json()).data.authorizationId as string;
    // A retry after the provider response is lost must use the durable,
    // tenant/league/command-key replay evidence before contacting Square.
    providerFactory.mockClear();
    providerFactory.mockRejectedValue(new Error("provider unavailable"));
    const replay = await request(`/api/financials/f3/leagues/${league().id}/authorize`, { method: "POST", body: JSON.stringify(authorizationBody) }, payer());
    expect(replay.status).toBe(200);
    expect((await replay.json()).data).toMatchObject({ authorizationId, replay: true });
    expect(providerFactory).not.toHaveBeenCalled();
    const changedReplay = await request(`/api/financials/f3/leagues/${league().id}/authorize`, { method: "POST", body: JSON.stringify({ ...authorizationBody, sourceId: "different-card" }) }, payer());
    expect(changedReplay.status).toBe(409);
    expect(bodyCode(await changedReplay.json())).toBe("IDEMPOTENCY_CONFLICT");
    expect(providerFactory).not.toHaveBeenCalled();
    const revoked = await request(`/api/financials/f3/leagues/${league().id}/authorize/${authorizationId}/revoke`, { method: "POST", body: "{}" }, payer());
    expect(revoked.status).toBe(200);
  });

  it("permits explicit system-admin organization scope without widening ordinary payer scope", async () => {
    const response = await request(`/api/financials/f3/leagues/${league().id}/policy/candidates?organizationId=${fixture.organizationId}`, {}, systemAdmin());
    expect(response.status).toBe(200);
    expect(bodyCode(await response.json())).not.toBe("F3_DISABLED");
    const wrongPayer = await request(`/api/financials/f3/leagues/${league().id}/authorize`, { method: "POST", body: JSON.stringify({ payerBowlerId: payerBowlerId + 999999 }) }, systemAdmin());
    expect(wrongPayer.status).toBe(404);
  });

  it("does not disclose an enabled league through a foreign organization scope", async () => {
    const foreign = await request(`/api/financials/f3/leagues/${league().id}/policy/candidates?organizationId=${fixture.organizationId + 1000000}`, {}, admin());
    expect(foreign.status).toBe(404);
    const body = await foreign.json();
    expect(bodyCode(body)).toBe("NOT_FOUND");
    expect(JSON.stringify(body)).not.toContain(fixture.activationId);
  });

  it("rejects inactive authorization before any provider ownership lookup", async () => {
    providerFactory.mockClear();
    await testDb.update(leagues).set({ active: false }).where(eq(leagues.id, fixture.leagueId));
    try {
      const response = await request(`/api/financials/f3/leagues/${league().id}/authorize`, { method: "POST", body: JSON.stringify({ payerBowlerId }) }, payer());
      expect(response.status).toBe(404);
      expect(bodyCode(await response.json())).toBe("NOT_FOUND");
      expect(providerFactory).not.toHaveBeenCalled();
    } finally {
      await testDb.update(leagues).set({ active: true }).where(eq(leagues.id, fixture.leagueId));
    }
  });
});
