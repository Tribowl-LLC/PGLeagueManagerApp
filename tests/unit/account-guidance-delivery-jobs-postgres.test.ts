/** PostgreSQL boundaries for normalized, cross-endpoint guidance throttling. */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { accountGuidanceDeliveryJobs } from "@shared/schema/account-guidance-delivery-jobs";
import { accountActionDeliveryJobs } from "@shared/schema/account-action-delivery-jobs";
import { accountActionRequests } from "@shared/schema/account-action-requests";
import { users } from "@shared/schema/users";
import {
  claimNextAccountGuidanceDeliveryJob,
  enqueueAccountGuidanceNotice,
  finalizeAccountGuidanceDeliveryJob,
  recoverAccountGuidanceDeliveryJobs,
} from "../../server/storage/account-guidance-delivery-jobs";
import { enqueuePasswordResetDelivery } from "../../server/storage/account-action-delivery-jobs";
import { accountGuidanceDeliveryProductionDependencies } from "../../server/services/account-guidance-delivery-worker";
import { getTestDb } from "../setup/test-db";
import { getBaselineOrgIds } from "../helpers";

const db = getTestDb();
const suffix = `${process.env.VITEST_POOL_ID ?? "0"}-${Date.now()}`;
const recipients: string[] = [];
const userIds: number[] = [];
let orgAId = 0;
let orgBId = 0;

beforeAll(async () => {
  ({ orgAId, orgBId } = await getBaselineOrgIds());
});

async function cleanup(): Promise<void> {
  if (recipients.length > 0) {
    await db.delete(accountGuidanceDeliveryJobs)
      .where(inArray(accountGuidanceDeliveryJobs.recipientEmail, recipients));
    recipients.splice(0, recipients.length);
  }
  if (userIds.length > 0) {
    await db.delete(users).where(inArray(users.id, userIds));
    userIds.splice(0, userIds.length);
  }
}

afterEach(cleanup);
afterAll(cleanup);

function recipient(label: string): string {
  const value = `${label}-${suffix}@example.test`;
  recipients.push(value.toLowerCase());
  return value;
}

async function createFixtureUser(label: string, password = "placeholder-password-hash") {
  const [user] = await db.insert(users).values({
    name: `${label} ${suffix}`,
    email: `${label.toLowerCase()}-${suffix}@example.test`,
    password,
    role: "user",
    organizationId: orgAId,
  }).returning();
  if (!user) throw new Error("guidance user fixture was not created");
  userIds.push(user.id);
  return user;
}

describe("account guidance delivery queue PostgreSQL boundaries", () => {
  it("normalizes recipients and shares cooldown across endpoints and tenants", async () => {
    const address = recipient("cross-endpoint");
    const [first, second] = await Promise.all([
      enqueueAccountGuidanceNotice({
        recipientEmail: `  ${address.toUpperCase()} `,
        noticeType: "account_missing",
        organizationId: orgAId,
      }),
      enqueueAccountGuidanceNotice({
        recipientEmail: address,
        noticeType: "account_exists",
        organizationId: orgBId,
      }),
    ]);

    const enqueued = [first, second].find((result) => result.kind === "enqueued");
    const suppressed = [first, second].find((result) => result.kind === "suppressed");
    expect(enqueued?.kind).toBe("enqueued");
    expect(suppressed).toMatchObject({ kind: "suppressed", reason: "cooldown" });
    if (enqueued?.kind !== "enqueued") return;
    expect(enqueued.job.recipientEmail).toBe(address.toLowerCase());

    const claim = await claimNextAccountGuidanceDeliveryJob({ workerId: "guidance-cross-endpoint" });
    expect(claim?.job.id).toBe(enqueued.job.id);
    expect(await finalizeAccountGuidanceDeliveryJob({
      jobId: enqueued.job.id,
      leaseToken: claim?.leaseToken ?? "missing-lease",
      outcome: { status: "succeeded", providerMessageId: "provider-message" },
    })).toBe(true);

    const afterCompletion = await enqueueAccountGuidanceNotice({
      recipientEmail: address,
      noticeType: "account_exists",
      organizationId: orgBId,
    });
    expect(afterCompletion).toMatchObject({ kind: "suppressed", reason: "cooldown" });
  });

  it("enforces the rolling cap after cooldown windows pass", async () => {
    const address = recipient("rolling-cap");
    const jobIds: number[] = [];
    for (let index = 0; index < 6; index += 1) {
      const result = await enqueueAccountGuidanceNotice({
        recipientEmail: address,
        noticeType: index % 2 === 0 ? "account_missing" : "account_exists",
        organizationId: index % 2 === 0 ? orgAId : orgBId,
      });
      expect(result.kind).toBe("enqueued");
      if (result.kind !== "enqueued") return;
      jobIds.push(result.job.id);
      const claim = await claimNextAccountGuidanceDeliveryJob({ workerId: `guidance-cap-${index}` });
      if (!claim) throw new Error("guidance cap fixture was not claimed");
      expect(await finalizeAccountGuidanceDeliveryJob({
        jobId: result.job.id,
        leaseToken: claim.leaseToken,
        outcome: { status: "succeeded", providerMessageId: `provider-${index}` },
      })).toBe(true);
      await db.update(accountGuidanceDeliveryJobs)
        .set({ createdAt: new Date(Date.now() - 6 * 60_000).toISOString() })
        .where(eq(accountGuidanceDeliveryJobs.id, result.job.id));
    }

    const capped = await enqueueAccountGuidanceNotice({
      recipientEmail: address,
      noticeType: "account_missing",
      organizationId: orgAId,
    });
    expect(capped).toMatchObject({ kind: "suppressed", reason: "hourly_cap" });

    const rows = await db.select({ id: accountGuidanceDeliveryJobs.id })
      .from(accountGuidanceDeliveryJobs)
      .where(and(
        eq(accountGuidanceDeliveryJobs.recipientEmail, address.toLowerCase()),
        inArray(accountGuidanceDeliveryJobs.id, jobIds),
      ));
    expect(rows).toHaveLength(6);
  });

  it("reclaims an expired lease, fences stale completion, and cleans retained rows", async () => {
    const address = recipient("lease-recovery");
    const enqueued = await enqueueAccountGuidanceNotice({
      recipientEmail: address,
      noticeType: "account_missing",
      organizationId: orgAId,
    });
    if (enqueued.kind !== "enqueued") throw new Error("lease fixture was suppressed");
    const first = await claimNextAccountGuidanceDeliveryJob({ workerId: "guidance-lease-a" });
    if (!first) throw new Error("first guidance lease was not claimed");
    await db.update(accountGuidanceDeliveryJobs)
      .set({ leaseExpiresAt: new Date(Date.now() - 1_000).toISOString() })
      .where(eq(accountGuidanceDeliveryJobs.id, enqueued.job.id));
    const recovered = await claimNextAccountGuidanceDeliveryJob({ workerId: "guidance-lease-b" });
    expect(recovered?.job.attemptCount).toBe(2);
    expect(recovered?.leaseToken).not.toBe(first.leaseToken);
    expect(await finalizeAccountGuidanceDeliveryJob({
      jobId: enqueued.job.id,
      leaseToken: first.leaseToken,
      outcome: { status: "succeeded", providerMessageId: "stale-provider" },
    })).toBe(false);
    expect(await finalizeAccountGuidanceDeliveryJob({
      jobId: enqueued.job.id,
      leaseToken: recovered?.leaseToken ?? "missing-lease",
      outcome: { status: "succeeded", providerMessageId: "current-provider" },
    })).toBe(true);

    await db.update(accountGuidanceDeliveryJobs)
      .set({ completedAt: new Date(Date.now() - 31 * 24 * 60 * 60_000).toISOString() })
      .where(eq(accountGuidanceDeliveryJobs.id, enqueued.job.id));
    await recoverAccountGuidanceDeliveryJobs();
    const retained = await db.select({ id: accountGuidanceDeliveryJobs.id })
      .from(accountGuidanceDeliveryJobs)
      .where(eq(accountGuidanceDeliveryJobs.id, enqueued.job.id));
    expect(retained).toHaveLength(0);
  });

  it.each(["pending", "failed"] as const)(
    "suppresses account-exists guidance for an unfinished registration origin in %s state",
    async (status) => {
      const user = await createFixtureUser(`registration-${status}`);
      const registration = await enqueuePasswordResetDelivery({
        userId: user.id,
        organizationId: orgAId,
        credentialGeneration: user.credentialGeneration,
        expiresAt: new Date(Date.now() + 60 * 60_000),
        action: "account_registration",
      });
      if (registration.kind !== "enqueued") throw new Error("registration origin was suppressed");
      if (status === "failed") {
        await db.update(accountActionDeliveryJobs)
          .set({
            status: "failed",
            completedAt: new Date().toISOString(),
            lastErrorCode: "provider_error",
          })
          .where(eq(accountActionDeliveryJobs.id, registration.job.id));
      }

      const target = await accountGuidanceDeliveryProductionDependencies.loadTarget({
        id: registration.job.id + 10_000,
        userId: user.id,
        recipientEmail: user.email,
        noticeType: "account_exists",
        organizationId: orgAId,
        status: "pending",
        attemptCount: 0,
        nextAttemptAt: new Date().toISOString(),
        lastAttemptAt: null,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        providerMessageId: null,
        lastErrorCode: null,
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        completedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      expect(target).toBeUndefined();
    },
  );

  it("uses the current user's organization for established-account links", async () => {
    const user = await createFixtureUser("established", "real-password-hash");
    const target = await accountGuidanceDeliveryProductionDependencies.loadTarget({
      id: 900_000,
      userId: user.id,
      recipientEmail: user.email,
      noticeType: "account_exists",
      organizationId: orgBId,
      status: "pending",
      attemptCount: 0,
      nextAttemptAt: new Date().toISOString(),
      lastAttemptAt: null,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      providerMessageId: null,
      lastErrorCode: null,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      completedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    expect(target).toMatchObject({
      recipientEmail: user.email,
      organization: { id: orgAId, active: true },
    });
  });

  it("suppresses an account-exists notice while an administrator invite is pending", async () => {
    const user = await createFixtureUser("invited");
    await db.insert(accountActionRequests).values({
      userId: user.id,
      organizationId: orgAId,
      action: "account_invite",
      tokenHash: `${String(user.id).padStart(2, "0")}${"a".repeat(62)}`,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      status: "pending",
      deliveryStatus: "not_attempted",
    });

    const target = await accountGuidanceDeliveryProductionDependencies.loadTarget({
      id: 901_000,
      userId: user.id,
      recipientEmail: user.email,
      noticeType: "account_exists",
      organizationId: orgAId,
      status: "pending",
      attemptCount: 0,
      nextAttemptAt: new Date().toISOString(),
      lastAttemptAt: null,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      providerMessageId: null,
      lastErrorCode: null,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      completedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(target).toBeUndefined();
  });
});
