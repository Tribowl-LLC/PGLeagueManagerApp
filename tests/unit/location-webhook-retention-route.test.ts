import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const { EvidenceError, OccurrenceEvidenceError, LeagueReferenceError, mockStorage, fakeLogger } = vi.hoisted(() => ({
  EvidenceError: class LocationWebhookEvidenceExistsError extends Error {},
  OccurrenceEvidenceError: class LocationOccurrenceEvidenceExistsError extends Error {},
  LeagueReferenceError: class LocationLeagueReferenceExistsError extends Error {},
  mockStorage: {
    getLocation: vi.fn(),
    deleteLocation: vi.fn(),
  },
  fakeLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../../server/storage", () => ({ storage: mockStorage }));
vi.mock("../../server/storage/locations", () => ({
  LocationLeagueReferenceExistsError: LeagueReferenceError,
  LocationWebhookEvidenceExistsError: EvidenceError,
  LocationOccurrenceEvidenceExistsError: OccurrenceEvidenceError,
}));
vi.mock("../../server/services/payment-provider-factory", () => ({
  clearProviderCache: vi.fn(),
}));
vi.mock("../../server/logger", () => ({
  logger: fakeLogger,
  createLogger: () => fakeLogger,
}));

const locationsRouter = (await import("../../server/routes/locations")).default;

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.assign(req, {
      user: { id: 7, role: "org_admin", organizationId: 41, bowlerId: null },
    });
    next();
  });
  app.use("/api/locations", locationsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
});

beforeEach(() => {
  for (const fn of Object.values(mockStorage)) fn.mockReset();
  for (const fn of Object.values(fakeLogger)) fn.mockReset();
  mockStorage.getLocation.mockResolvedValue({ id: 9, organizationId: 41 });
});

describe("DELETE /api/locations/:id webhook evidence retention", () => {
  it("returns a clean conflict and recommends archival", async () => {
    mockStorage.deleteLocation.mockRejectedValue(new EvidenceError());

    const response = await fetch(`${baseUrl}/api/locations/9`, { method: "DELETE" });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toMatchObject({
      success: false,
      error: {
        code: "LOCATION_WEBHOOK_EVIDENCE_EXISTS",
        message: expect.stringContaining("Archive"),
      },
    });
    expect(fakeLogger.error).not.toHaveBeenCalled();
  });

  it("returns a clean conflict and recommends archival for occurrence evidence", async () => {
    mockStorage.deleteLocation.mockRejectedValue(new OccurrenceEvidenceError());

    const response = await fetch(`${baseUrl}/api/locations/9`, { method: "DELETE" });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toMatchObject({
      success: false,
      error: {
        code: "LOCATION_OCCURRENCE_EVIDENCE_EXISTS",
        message: expect.stringContaining("Archive"),
      },
    });
    expect(fakeLogger.error).not.toHaveBeenCalled();
  });

  it("returns a clean conflict when a location is still assigned to a league", async () => {
    mockStorage.deleteLocation.mockRejectedValue(new LeagueReferenceError());

    const response = await fetch(`${baseUrl}/api/locations/9`, { method: "DELETE" });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toMatchObject({
      success: false,
      error: {
        code: "LOCATION_LEAGUE_REFERENCED",
        message: expect.stringContaining("assigned to a league"),
      },
    });
    expect(fakeLogger.error).not.toHaveBeenCalled();
  });
});
