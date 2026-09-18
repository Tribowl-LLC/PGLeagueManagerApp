import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProfileClaimNotification } from "@shared/schema/profile-claim-notifications";

vi.mock("../../server/db", () => ({ db: {} }));
vi.mock("../../server/storage/index.js", () => ({ storage: {} }));
vi.mock("../../server/storage", () => ({ storage: {} }));
vi.mock("../../server/services/email", () => ({
  getBaseUrl: vi.fn(() => "https://league.example.test"),
  sendProfileClaimNotificationEmail: vi.fn(async () => ({ accepted: true })),
}));
vi.mock("../../server/storage/profile-claim-notifications.js", () => ({
  claimNextProfileClaimNotification: vi.fn(),
  finalizeProfileClaimNotification: vi.fn(),
  isCurrentProfileClaimNotification: vi.fn(),
  recoverProfileClaimNotifications: vi.fn(),
  profileClaimReportTokenForEvent: vi.fn(() => "a".repeat(64)),
  shouldCombineProfileClaimWithAccountReady: vi.fn(async () => false),
}));

import {
  ProfileClaimNotificationWorker,
  type ProfileClaimNotificationWorkerDependencies,
} from "../../server/services/profile-claim-notification-worker";

const NOW = "2030-01-01T00:00:00.000Z";

function makeNotification(overrides: Partial<ProfileClaimNotification> = {}): ProfileClaimNotification {
  return {
    id: 41,
    identityLinkEventId: 900,
    userId: 901,
    bowlerId: 902,
    organizationId: 903,
    recipientEmail: "roster@example.test",
    recipientSource: "roster",
    recipientName: "Roster Member",
    bowlerName: "Roster Member",
    reportTokenHash: "b".repeat(64),
    reportTokenExpiresAt: "2030-01-08T00:00:00.000Z",
    status: "processing",
    attemptCount: 1,
    nextAttemptAt: NOW,
    lastAttemptAt: NOW,
    leaseOwner: "test-worker",
    leaseToken: "lease-1",
    leaseExpiresAt: "2030-01-01T00:01:00.000Z",
    providerMessageId: null,
    lastErrorCode: null,
    completedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeDependencies(
  overrides: Partial<ProfileClaimNotificationWorkerDependencies> = {},
): ProfileClaimNotificationWorkerDependencies {
  const notification = makeNotification();
  return {
    claim: vi.fn(async () => ({ notification, leaseToken: "lease-1" })),
    recover: vi.fn(async () => 0),
    loadTarget: vi.fn(async () => true),
    send: vi.fn(async () => ({ accepted: true, providerMessageId: "provider-1" })),
    finalize: vi.fn(async () => true),
    now: () => Date.parse(NOW),
    ...overrides,
  };
}

afterEach(() => vi.useRealTimers());

describe("ProfileClaimNotificationWorker", () => {
  it("suppresses a notification whose identity-link event is no longer current", async () => {
    const dependencies = makeDependencies({
      loadTarget: vi.fn(async () => false),
    });
    const worker = new ProfileClaimNotificationWorker(dependencies);

    await expect(worker.runOne()).resolves.toMatchObject({
      kind: "processed",
      outcome: "suppressed",
    });
    expect(dependencies.send).not.toHaveBeenCalled();
    expect(dependencies.finalize).toHaveBeenCalledWith({
      notificationId: 41,
      leaseToken: "lease-1",
      outcome: { status: "suppressed", reason: "state_changed" },
    });
  });
});
