import { beforeEach, describe, expect, it, vi } from "vitest";

const { getOrganization, getActiveOrganizations } = vi.hoisted(() => {
  process.env.DATABASE_URL = "postgres://unit.test/leaguevault";
  process.env.SESSION_SECRET = "unit-test-session-secret";
  process.env.FIELD_ENCRYPTION_KEY = "0".repeat(64);
  process.env.APP_ORGANIZATION_ID = "7";
  return { getOrganization: vi.fn(), getActiveOrganizations: vi.fn() };
});

vi.mock("../../server/storage/index.js", () => ({
  storage: { getOrganization, getActiveOrganizations },
}));

import {
  pinConfiguredOrganization,
  resetPinnedOrganizationForTests,
  resolveConfiguredOrganization,
} from "../../server/services/single-tenant-context";
import type { Organization } from "../../shared/schema";

function organizationRow(overrides: Partial<Organization> = {}): Organization {
  return Object.assign({}, { id: 7, active: true, name: "Perfect Game", slug: "leaguevault", subdomain: "main" }, overrides) as Organization;
}

describe("pinned configured organization", () => {
  beforeEach(() => {
    resetPinnedOrganizationForTests();
    getOrganization.mockReset();
    getActiveOrganizations.mockReset();
    getOrganization.mockResolvedValue(organizationRow());
    getActiveOrganizations.mockResolvedValue([{ id: 7, active: true }]);
  });

  it("reads the database once and serves later requests from the pin", async () => {
    const first = await resolveConfiguredOrganization();
    const lookups = getOrganization.mock.calls.length;

    const second = await resolveConfiguredOrganization();

    expect(second).toBe(first);
    expect(getOrganization).toHaveBeenCalledTimes(lookups);
    expect(getActiveOrganizations).toHaveBeenCalledOnce();
  });

  it("shares one load between concurrent first requests", async () => {
    const [first, second] = await Promise.all([
      resolveConfiguredOrganization(),
      resolveConfiguredOrganization(),
    ]);

    expect(second).toBe(first);
    expect(getActiveOrganizations).toHaveBeenCalledOnce();
  });

  it("does not pin a failed validation and retries on the next request", async () => {
    getActiveOrganizations.mockResolvedValueOnce([{ id: 7, active: true }, { id: 8, active: true }]);

    await expect(resolveConfiguredOrganization()).rejects.toMatchObject({ code: "multiple_active_organizations" });
    await expect(resolveConfiguredOrganization()).resolves.toMatchObject({ id: 7 });
  });

  it("does not pin a database failure", async () => {
    getOrganization.mockRejectedValueOnce(new Error("connection terminated"));

    await expect(resolveConfiguredOrganization()).rejects.toThrow("connection terminated");
    await expect(resolveConfiguredOrganization()).resolves.toMatchObject({ id: 7 });
  });

  it("re-pins the row saved by Business Settings without another lookup", async () => {
    await resolveConfiguredOrganization();
    const lookups = getOrganization.mock.calls.length;

    pinConfiguredOrganization(organizationRow({ name: "Perfect Game Lanes" }));

    await expect(resolveConfiguredOrganization()).resolves.toMatchObject({ name: "Perfect Game Lanes" });
    expect(getOrganization).toHaveBeenCalledTimes(lookups);
  });

  it("ignores a re-pin for another or an inactive organization", async () => {
    await resolveConfiguredOrganization();

    pinConfiguredOrganization(organizationRow({ id: 8, name: "Other" }));
    pinConfiguredOrganization(organizationRow({ active: false, name: "Inactive" }));

    await expect(resolveConfiguredOrganization()).resolves.toMatchObject({ id: 7, name: "Perfect Game" });
  });

  it("does not create a pin from a save before the first validated load", async () => {
    pinConfiguredOrganization(organizationRow({ name: "Unvalidated" }));

    await expect(resolveConfiguredOrganization()).resolves.toMatchObject({ name: "Perfect Game" });
    expect(getActiveOrganizations).toHaveBeenCalledOnce();
  });
});
