import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const { ArchiveError, ScopeError, mockStorage, fakeLogger } = vi.hoisted(() => ({
  ArchiveError: class TeamDeletionRequiresArchiveError extends Error {},
  ScopeError: class TeamOrganizationChangedError extends Error {},
  mockStorage: {
    getTeam: vi.fn(),
    getLeague: vi.fn(),
    deleteTeam: vi.fn(),
  },
  fakeLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    captureException: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../../server/storage", () => ({ storage: mockStorage }));
vi.mock("../../server/storage/teams", () => ({
  TeamDeletionRequiresArchiveError: ArchiveError,
  TeamOrganizationChangedError: ScopeError,
}));
vi.mock("../../server/utils/access-control", () => ({
  hasAdminAccessToLeague: vi.fn().mockResolvedValue(true),
  hasLeagueOperationsAccess: vi.fn().mockResolvedValue(true),
  isOrgOrHigher: vi.fn().mockReturnValue(true),
  isPaymentManager: vi.fn().mockReturnValue(false),
}));
vi.mock("../../server/logger", () => ({
  logger: fakeLogger,
  createLogger: () => fakeLogger,
}));

const teamsRouter = (await import("../../server/routes/teams")).default;

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
  app.use("/api/teams", teamsRouter);
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
  mockStorage.getTeam.mockResolvedValue({ id: 9, leagueId: 12, name: "Fixture", number: 1, active: true, displayOrder: 0 });
  mockStorage.getLeague.mockResolvedValue({ id: 12, organizationId: 41 });
});

describe("DELETE /api/teams/:id", () => {
  it("returns a deliberate archive conflict for retained financial evidence", async () => {
    mockStorage.deleteTeam.mockRejectedValue(new ArchiveError());

    const response = await fetch(`${baseUrl}/api/teams/9`, { method: "DELETE" });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toMatchObject({
      success: false,
      error: {
        code: "TEAM_DELETE_REQUIRES_ARCHIVE",
        message: expect.stringContaining("Archive"),
      },
    });
    expect(mockStorage.deleteTeam).toHaveBeenCalledWith(9, 41);
    expect(fakeLogger.error).not.toHaveBeenCalled();
  });

  it("does not report a cross-tenant scope race as a successful deletion", async () => {
    mockStorage.deleteTeam.mockRejectedValue(new ScopeError());

    const response = await fetch(`${baseUrl}/api/teams/9`, { method: "DELETE" });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("TEAM_SCOPE_CHANGED");
    expect(fakeLogger.error).not.toHaveBeenCalled();
  });

  it("passes the authorized organization scope and leaves renumbering to storage", async () => {
    mockStorage.deleteTeam.mockResolvedValue(undefined);

    const response = await fetch(`${baseUrl}/api/teams/9`, { method: "DELETE" });

    expect(response.status).toBe(200);
    expect(mockStorage.deleteTeam).toHaveBeenCalledWith(9, 41);
    expect(mockStorage.deleteTeam).toHaveBeenCalledTimes(1);
  });

  it("captures an unexpected delete error once while keeping SQL out of logs and responses", async () => {
    const databaseError = Object.assign(
      new Error('Failed query: DELETE FROM teams /* private roster history */'),
      { code: '23503' },
    );
    mockStorage.deleteTeam.mockRejectedValue(databaseError);

    const response = await fetch(`${baseUrl}/api/teams/9`, { method: "DELETE" });
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toMatchObject({
      success: false,
      error: { message: 'Failed to delete team' },
    });
    expect(fakeLogger.captureException).toHaveBeenCalledOnce();
    expect(fakeLogger.captureException).toHaveBeenCalledWith(databaseError);
    expect(fakeLogger.error).toHaveBeenCalledOnce();
    expect(fakeLogger.error).toHaveBeenCalledWith('Error deleting team:', {
      operation: 'team_delete',
      errorType: 'Error',
      errorCode: '23503',
    });
    expect(JSON.stringify(fakeLogger.error.mock.calls[0])).not.toContain('DELETE FROM teams');
    expect(JSON.stringify(body)).not.toContain('private roster history');
  });
});
