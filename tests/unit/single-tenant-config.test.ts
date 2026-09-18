import { describe, expect, it, vi } from "vitest";
vi.hoisted(() => {
  process.env.DATABASE_URL = "postgres://unit.test/leaguevault";
  process.env.SESSION_SECRET = "unit-test-session-secret";
  process.env.FIELD_ENCRYPTION_KEY = "0".repeat(64);
});
import {
  envSchema,
  parsePositiveSafeInteger,
  validateProductionLikeRequiredConfiguration,
} from "../../server/config";

describe("APP_ORGANIZATION_ID configuration", () => {
  const field = envSchema.shape.APP_ORGANIZATION_ID;

  it("parses a positive safe integer and remains optional at boot", () => {
    expect(field.safeParse("42")).toMatchObject({ success: true, data: 42 });
    expect(field.safeParse(undefined)).toMatchObject({ success: true, data: undefined });
  });

  it.each(["", "0", "-1", "1.5", "1e3", "9007199254740992", " 42 "])('rejects unsafe value %s', (value) => {
    expect(field.safeParse(value).success).toBe(false);
  });

  it("keeps production-like readiness separate from boot parsing", () => {
    expect(validateProductionLikeRequiredConfiguration({
      appOrganizationId: undefined,
      nodeEnv: "test",
      appEnv: undefined,
    })).toEqual({ ok: true, productionLike: false, organizationId: undefined });
    expect(validateProductionLikeRequiredConfiguration({
      appOrganizationId: undefined,
      nodeEnv: "production",
      appEnv: "prod",
    })).toMatchObject({ ok: false, reason: expect.stringContaining("APP_ORGANIZATION_ID") });
    expect(validateProductionLikeRequiredConfiguration({
      appOrganizationId: "42",
      nodeEnv: "production",
      appEnv: "prod",
    })).toEqual({ ok: true, productionLike: true, organizationId: 42 });
  });

  it("rejects precision-losing identifiers in the pure parser", () => {
    expect(parsePositiveSafeInteger("9007199254740992")).toBeUndefined();
    expect(parsePositiveSafeInteger("42")).toBe(42);
    expect(parsePositiveSafeInteger(42)).toBe(42);
  });
});
