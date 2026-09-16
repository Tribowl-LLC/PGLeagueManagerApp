import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const mocks = vi.hoisted(() => ({
  getLeague: vi.fn(),
  hasAdmin: vi.fn(),
  hasPaymentManager: vi.fn(),
  readReport: vi.fn(),
  renderPdf: vi.fn(),
  filename: vi.fn(),
}));

vi.mock("../../server/storage/index.js", () => ({ storage: { getLeague: (...args: unknown[]) => mocks.getLeague(...args), getLeagues: vi.fn() } }));
vi.mock("../../server/services/roster-payment-core.js", () => ({
  readCanonicalDuePastDue: vi.fn(),
  RosterPaymentError: class extends Error {
    constructor(public readonly code: string, message: string, public readonly status = 409) { super(message); }
  },
}));
vi.mock("../../server/services/league-occurrence-schedule.js", () => ({
  LeagueOccurrenceScheduleError: class extends Error {
    constructor(public readonly code: string, message: string) { super(message); }
  },
}));
vi.mock("../../server/services/team-envelope-report.js", () => ({
  TeamEnvelopeReportError: class extends Error {
    constructor(public readonly code: string, message: string, public readonly status: number) { super(message); }
  },
  readTeamEnvelopeReport: (...args: unknown[]) => mocks.readReport(...args),
  renderTeamEnvelopePdf: (...args: unknown[]) => mocks.renderPdf(...args),
  teamEnvelopeFilename: (...args: unknown[]) => mocks.filename(...args),
}));
vi.mock("../../server/utils/access-control.js", () => ({
  hasAdminAccessToLeague: (...args: unknown[]) => mocks.hasAdmin(...args),
  hasPaymentManagerAccessToLeague: (...args: unknown[]) => mocks.hasPaymentManager(...args),
  hasAccessToLeague: vi.fn(),
  isPaymentManager: (user: { role?: string } | undefined) => user?.role === "payment_manager",
}));

const router = (await import("../../server/routes/financials.js")).default;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use((req, _res, next) => {
    const raw = req.header("x-test-user");
    if (raw) Object.defineProperty(req, "user", { value: JSON.parse(raw), configurable: true });
    next();
  });
  app.use("/api/financials", router);
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", () => resolve()); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getLeague.mockResolvedValue({ id: 7, name: "Wednesday Ladies", organizationId: 11 });
  mocks.hasAdmin.mockResolvedValue(true);
  mocks.hasPaymentManager.mockResolvedValue(false);
  mocks.readReport.mockResolvedValue({ leagueId: 7, organizationId: 11, weekLabel: "2" });
  mocks.renderPdf.mockResolvedValue(Uint8Array.from(Buffer.from("%PDF-test")));
  mocks.filename.mockReturnValue("wednesday-ladies-week-2-team-envelope-slips.pdf");
});

function user(role: string, organizationId: number | null) {
  return { id: 1, role, organizationId, bowlerId: null };
}

function get(path: string, currentUser: ReturnType<typeof user>) {
  return fetch(`${baseUrl}/api/financials${path}`, {
    headers: { "x-test-user": JSON.stringify(currentUser) },
  });
}

describe("team envelope PDF route", () => {
  it("returns a no-store PDF to a league administrator", async () => {
    const response = await get("/leagues/7/team-envelope-slips.pdf", user("org_admin", 11));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/pdf");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="wednesday-ladies-week-2-team-envelope-slips.pdf"');
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.readReport).toHaveBeenCalledWith({ organizationId: 11, leagueId: 7 });
    expect(Buffer.from(await response.arrayBuffer()).toString("ascii")).toBe("%PDF-test");
  });

  it("fails closed across tenant boundaries before reading financial evidence", async () => {
    const response = await get("/leagues/7/team-envelope-slips.pdf", user("org_admin", 12));

    expect(response.status).toBe(404);
    expect(mocks.readReport).not.toHaveBeenCalled();
  });

  it("requires an explicit selected organization for a system administrator", async () => {
    const missingScope = await get("/leagues/7/team-envelope-slips.pdf", user("system_admin", null));
    const wrongScope = await get("/leagues/7/team-envelope-slips.pdf?organizationId=12", user("system_admin", null));
    const selectedScope = await get("/leagues/7/team-envelope-slips.pdf?organizationId=11", user("system_admin", null));

    expect(missingScope.status).toBe(400);
    expect(wrongScope.status).toBe(404);
    expect(selectedScope.status).toBe(200);
  });

  it("returns a deliberate conflict when report evidence is not printable", async () => {
    const service = await import("../../server/services/team-envelope-report.js");
    mocks.readReport.mockRejectedValue(new service.TeamEnvelopeReportError("ROSTER_INCOMPLETE", "Complete the roster", 409));

    const response = await get("/leagues/7/team-envelope-slips.pdf", user("org_admin", 11));
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatchObject({ code: "ROSTER_INCOMPLETE", message: "Complete the roster" });
  });
});
