import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";

const { resolveConfiguredOrganization } = vi.hoisted(() => ({
  resolveConfiguredOrganization: vi.fn(),
}));

vi.mock("../../server/config", () => ({
  env: {
    APP_DOMAIN: "leaguevault.app",
    LEGACY_ORG_HOSTS: ["legacy.leaguevault.app"],
  },
  isProdLike: true,
  isSingletonOrganizationMode: true,
}));

vi.mock("../../server/services/single-tenant-context", () => ({
  resolveConfiguredOrganization,
  SingleTenantContextError: class SingleTenantContextError extends Error {},
}));

vi.mock("../../server/middleware/subdomain", () => ({
  subdomainDetection: vi.fn(),
}));

import { singletonOrganizationContext } from "../../server/middleware/single-tenant";
import { rejectForeignOrganizationInput } from "../../server/middleware/organization-input";

const organization = { id: 42, active: true, slug: "leaguevault" };

function responseMock() {
  // eslint-disable-next-line no-restricted-syntax
  return Object.assign({}, {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    redirect: vi.fn(),
  }) as unknown as Response;
}

function requestMock(overrides: Partial<Request> = {}) {
  return Object.assign({}, {
    hostname: "leaguevault.app",
    headers: {},
    method: "GET",
    originalUrl: "/",
    query: {},
    body: {},
  }, overrides) as Request;
}

describe("singleton organization request boundaries", () => {
  beforeEach(() => {
    resolveConfiguredOrganization.mockReset();
    resolveConfiguredOrganization.mockResolvedValue(organization);
  });

  it("redirects legacy browser links without consuming their path or query", async () => {
    const req = requestMock({
      hostname: "legacy.leaguevault.app",
      originalUrl: "/reset-password?token=opaque-token",
    });
    const res = responseMock();
    const next = vi.fn() as NextFunction;

    await singletonOrganizationContext(req, res, next);

    expect(res.redirect).toHaveBeenCalledWith(
      308,
      "https://leaguevault.app/reset-password?token=opaque-token",
    );
    expect(next).not.toHaveBeenCalled();
    expect(resolveConfiguredOrganization).not.toHaveBeenCalled();
  });

  it("rejects legacy mutation requests instead of redirecting them", async () => {
    const req = requestMock({ hostname: "legacy.leaguevault.app", method: "POST" });
    const res = responseMock();

    await singletonOrganizationContext(req, res, vi.fn() as NextFunction);

    expect(res.status).toHaveBeenCalledWith(421);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({ code: "CANONICAL_HOST_REQUIRED" }),
    }));
  });

  it("rejects unknown production hosts before resolving business context", async () => {
    const req = requestMock({ hostname: "unregistered.example" });
    const res = responseMock();

    await singletonOrganizationContext(req, res, vi.fn() as NextFunction);

    expect(res.status).toHaveBeenCalledWith(421);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({ code: "UNKNOWN_HOST" }),
    }));
    expect(resolveConfiguredOrganization).not.toHaveBeenCalled();
  });

  it("attaches the configured organization on the canonical host", async () => {
    const req = requestMock();
    const res = responseMock();
    const next = vi.fn() as NextFunction;

    await singletonOrganizationContext(req, res, next);

    expect(req.organizationContextId).toBe(42);
    expect(req.organizationContext).toEqual(organization);
    expect(next).toHaveBeenCalledOnce();
  });

  it("rejects foreign organization input while accepting the configured id", () => {
    const res = responseMock();
    const next = vi.fn() as NextFunction;
    const req = requestMock({
      organizationContextId: 42,
      query: { organizationId: "41" },
    });

    rejectForeignOrganizationInput(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({ code: "ORG_CONTEXT_MISMATCH" }),
    }));
    expect(next).not.toHaveBeenCalled();

    const acceptedNext = vi.fn() as NextFunction;
    rejectForeignOrganizationInput(
      requestMock({ organizationContextId: 42, body: { organizationId: 42 } }),
      responseMock(),
      acceptedNext,
    );
    expect(acceptedNext).toHaveBeenCalledOnce();
  });
});
