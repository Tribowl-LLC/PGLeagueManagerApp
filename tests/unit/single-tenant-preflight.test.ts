import { describe, expect, it } from "vitest";
import {
  buildSingleTenantPreflightReport,
  normalizeHostLabel,
  parseSingleTenantPreflightConfiguration,
} from "../../scripts/single-tenant-preflight";

describe("single-tenant preflight pure helpers", () => {
  it("requires a positive safe APP_ORGANIZATION_ID", () => {
    expect(parseSingleTenantPreflightConfiguration({})).toMatchObject({
      ok: false,
      code: "configuration_missing",
    });
    expect(parseSingleTenantPreflightConfiguration({ APP_ORGANIZATION_ID: "1.5" })).toMatchObject({
      ok: false,
      code: "configuration_invalid",
    });
    expect(parseSingleTenantPreflightConfiguration({ APP_ORGANIZATION_ID: "9007199254740992" })).toMatchObject({
      ok: false,
      code: "configuration_invalid",
    });
    expect(parseSingleTenantPreflightConfiguration({ APP_ORGANIZATION_ID: "42" })).toEqual({
      ok: true,
      organizationId: 42,
    });
  });

  it("normalizes and deduplicates host labels without exposing organization details", () => {
    expect(normalizeHostLabel(" Main.Example. ")).toBe("main.example");
    const report = buildSingleTenantPreflightReport(7, [{
      organizationId: 7,
      active: true,
      slug: "Main",
      subdomain: "main",
      users: 2,
      bowlers: 3,
      leagues: 1,
      locations: 2,
      pendingJobs: 4,
    }]);
    expect(report).toEqual({
      configuredOrganizationId: 7,
      activeOrganizationCount: 1,
      readiness: { ok: true, blockers: [] },
      organizations: [{
        id: 7,
        active: true,
        hostnames: ["main"],
        counts: { users: 2, bowlers: 3, leagues: 1, locations: 2, pendingJobs: 4, hostnames: 1 },
      }],
      totals: { users: 2, bowlers: 3, leagues: 1, locations: 2, pendingJobs: 4, hostnames: 1 },
    });
  });

  it("reports multiple active organizations as a readiness blocker", () => {
    const report = buildSingleTenantPreflightReport(7, [
      { organizationId: 7, active: true, slug: "one", subdomain: null, users: 0, bowlers: 0, leagues: 0, locations: 0, pendingJobs: 0 },
      { organizationId: 8, active: true, slug: "two", subdomain: null, users: 0, bowlers: 0, leagues: 0, locations: 0, pendingJobs: 0 },
    ]);
    expect(report.readiness).toEqual({
      ok: false,
      blockers: [{
        code: "multiple_active_organizations",
        message: "Expected exactly one active organization; found 2.",
      }],
    });
  });
});
