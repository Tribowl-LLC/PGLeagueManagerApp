import { describe, expect, it, vi } from "vitest";
vi.hoisted(() => {
  process.env.DATABASE_URL = "postgres://unit.test/leaguevault";
  process.env.SESSION_SECRET = "unit-test-session-secret";
  process.env.FIELD_ENCRYPTION_KEY = "0".repeat(64);
});
import {
  SingleTenantContextError,
  validateSingleTenantContext,
} from "../../server/services/single-tenant-context";

const organization = {
  id: 7,
  active: true,
  slug: "leaguevault",
  subdomain: "main",
};

const activeOrganization = { id: 7, active: true };

describe("validateSingleTenantContext", () => {
  it("returns a safe context for the configured only active organization", () => {
    expect(validateSingleTenantContext({
      configuredOrganizationId: 7,
      organization,
      activeOrganizations: [activeOrganization],
    })).toEqual({ ok: true, context: { organizationId: 7, organization } });
  });

  it("rejects a missing or invalid configured identifier", () => {
    expect(validateSingleTenantContext({
      configuredOrganizationId: undefined,
      organization: undefined,
      activeOrganizations: [],
    })).toMatchObject({ ok: false, error: { code: "configuration_missing" } });
    expect(validateSingleTenantContext({
      configuredOrganizationId: Number.MAX_SAFE_INTEGER + 1,
      organization: undefined,
      activeOrganizations: [],
    })).toMatchObject({ ok: false, error: { code: "configuration_invalid" } });
  });

  it.each([
    ["organization_not_found", undefined, [activeOrganization]],
    ["organization_inactive", { ...organization, active: false }, [activeOrganization]],
    ["no_active_organization", organization, []],
    ["multiple_active_organizations", organization, [activeOrganization, { id: 8, active: true }]],
    ["configured_organization_not_active", organization, [{ id: 8, active: true }]],
  ] as const)("returns the typed %s error", (code, row, activeOrganizations) => {
    const result = validateSingleTenantContext({
      configuredOrganizationId: 7,
      organization: row,
      activeOrganizations,
    });
    expect(result).toMatchObject({ ok: false, error: { code } });
    if (result.ok) throw new Error("expected a validation error");
    expect(result.error).toBeInstanceOf(SingleTenantContextError);
  });
});
