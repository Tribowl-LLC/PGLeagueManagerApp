import { describe, expect, it } from "vitest";
import { publicAccountInvitation } from "../../server/services/account-invitation";

describe("public account invitation state", () => {
  it("exposes lifecycle and delivery state without token material", () => {
    const result = publicAccountInvitation({
      id: 17,
      userId: 9,
      organizationId: 4,
      createdByUserId: 2,
      action: "account_invite",
      tokenHash: "a".repeat(64),
      expiresAt: "2030-01-01T00:00:00.000Z",
      status: "expired",
      deliveryStatus: "failed",
      deliveryAttemptedAt: "2029-12-25T00:00:00.000Z",
      deliveredAt: null,
      consumedAt: null,
      supersededAt: null,
      revokedAt: null,
      expiredAt: "2029-12-26T00:00:00.000Z",
      createdAt: "2029-12-24T00:00:00.000Z",
    });

    expect(result).toEqual({
      id: 17,
      action: "account_invite",
      status: "expired",
      deliveryStatus: "failed",
      expiresAt: "2030-01-01T00:00:00.000Z",
      deliveryAttemptedAt: "2029-12-25T00:00:00.000Z",
      deliveredAt: null,
      expiredAt: "2029-12-26T00:00:00.000Z",
      createdAt: "2029-12-24T00:00:00.000Z",
    });
    expect(result).not.toHaveProperty("token");
    expect(result).not.toHaveProperty("tokenHash");
  });

  it("returns null when no invitation exists", () => {
    expect(publicAccountInvitation(undefined)).toBeNull();
  });
});
