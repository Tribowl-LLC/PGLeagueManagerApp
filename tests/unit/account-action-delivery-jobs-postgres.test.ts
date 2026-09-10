/**
 * PostgreSQL coverage for the durable password-reset delivery queue. The
 * queue's leases, partial uniqueness, credential snapshots, and terminal
 * fences are database invariants and are intentionally tested against real
 * rows rather than mocked storage calls.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  accountActionDeliveryJobs,
  accountActionRequests,
  users,
} from "@shared/schema";
import {
  PASSWORD_RESET_PENDING_CAP,
  PasswordResetCapacityError,
  issueAccountAction,
  tryIssuePasswordReset,
} from "../../server/storage/account-action-requests";
import {
  attachPasswordResetActionToDeliveryJob,
  claimNextPasswordResetDeliveryJob,
  enqueuePasswordResetDelivery,
  finalizePasswordResetDeliveryJob,
  getNextPasswordResetDeliveryAt,
  recoverPasswordResetDeliveryJobs,
} from "../../server/storage/account-action-delivery-jobs";
import { getTestDb } from "../setup/test-db";
import { getBaselineOrgAId } from "../helpers";

const db = getTestDb();
const suffix = `${process.env.VITEST_POOL_ID ?? "0"}-${Date.now()}`;
const userIds: number[] = [];
let organizationId = 0;

async function createFixtureUser(label: string) {
  const [user] = await db.insert(users).values({
    name: `${label} ${suffix}`,
    email: `${label.toLowerCase().replaceAll(" ", "-")}-${suffix}@example.test`,
    password: "old-password-hash",
    role: "user",
    organizationId,
    mustChangePassword: false,
  }).returning();
  if (!user) throw new Error("delivery queue fixture user was not created");
  userIds.push(user.id);
  return user;
}

function deadline(minutes = 60): Date {
  return new Date(Date.now() + minutes * 60_000);
}

beforeAll(async () => {
  organizationId = await getBaselineOrgAId();
});

async function cleanupFixtureUsers(): Promise<void> {
  if (userIds.length > 0) {
    await db.delete(users).where(inArray(users.id, userIds));
    userIds.splice(0, userIds.length);
  }
}

afterEach(async () => {
  // Keep pending jobs from one specification out of the global worker claim
  // query used by the next specification in this isolated database.
  await cleanupFixtureUsers();
});

afterAll(async () => {
  await cleanupFixtureUsers();
});

describe("password-reset delivery queue PostgreSQL boundaries", () => {
  it("persists a non-secret intent and exposes its durable due timestamp", async () => {
    const user = await createFixtureUser("Queue Intent");
    const result = await enqueuePasswordResetDelivery({
      userId: user.id,
      organizationId,
      credentialGeneration: user.credentialGeneration,
      expiresAt: deadline(),
    });

    expect(result.kind).toBe("enqueued");
    if (result.kind !== "enqueued") return;
    expect(result.job).toMatchObject({
      userId: user.id,
      organizationId,
      action: "password_reset",
      credentialGeneration: user.credentialGeneration,
      status: "pending",
      attemptCount: 0,
    });
    expect(result.job).not.toHaveProperty("email");
    expect(result.job).not.toHaveProperty("token");
    expect(await getNextPasswordResetDeliveryAt()).toBeInstanceOf(Date);
  });

  it("coalesces concurrent intents to one active job", async () => {
    const user = await createFixtureUser("Queue Concurrent");
    const results = await Promise.all([
      enqueuePasswordResetDelivery({ userId: user.id, organizationId, expiresAt: deadline() }),
      enqueuePasswordResetDelivery({ userId: user.id, organizationId, expiresAt: deadline() }),
    ]);

    expect(results.filter((result) => result.kind === "enqueued")).toHaveLength(1);
    expect(results.filter((result) => result.kind === "suppressed" && result.reason === "active_job")).toHaveLength(1);
    const rows = await db.select({ id: accountActionDeliveryJobs.id })
      .from(accountActionDeliveryJobs)
      .where(and(
        eq(accountActionDeliveryJobs.userId, user.id),
        eq(accountActionDeliveryJobs.status, "pending"),
      ));
    expect(rows).toHaveLength(1);
  });

  it("retires an expired active intent before accepting a replacement", async () => {
    const user = await createFixtureUser("Queue Expiry");
    const [expired] = await db.insert(accountActionDeliveryJobs).values({
      userId: user.id,
      organizationId,
      action: "password_reset",
      credentialGeneration: user.credentialGeneration,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      status: "pending",
      attemptCount: 0,
      nextAttemptAt: new Date(Date.now() - 60_000).toISOString(),
    }).returning();
    if (!expired) throw new Error("expired delivery fixture was not created");

    const replacement = await enqueuePasswordResetDelivery({
      userId: user.id,
      organizationId,
      expiresAt: deadline(),
    });
    expect(replacement.kind).toBe("enqueued");
    const rows = await db.select({ id: accountActionDeliveryJobs.id, status: accountActionDeliveryJobs.status })
      .from(accountActionDeliveryJobs)
      .where(eq(accountActionDeliveryJobs.userId, user.id));
    expect(rows).toEqual(expect.arrayContaining([
      { id: expired.id, status: "failed" },
    ]));
    expect(rows.filter((row) => row.status === "pending")).toHaveLength(1);
  });

  it("claims once with SKIP LOCKED and fences a recovered worker", async () => {
    const user = await createFixtureUser("Queue Lease");
    const result = await enqueuePasswordResetDelivery({ userId: user.id, organizationId, expiresAt: deadline() });
    if (result.kind !== "enqueued") throw new Error("lease job was suppressed");

    const first = await claimNextPasswordResetDeliveryJob({ workerId: "queue-worker-a" });
    expect(first?.job).toMatchObject({ id: result.job.id, status: "processing", attemptCount: 1 });
    expect(first?.leaseToken).toBeTruthy();
    expect(await claimNextPasswordResetDeliveryJob({ workerId: "queue-worker-b" })).toBeUndefined();

    await db.update(accountActionDeliveryJobs).set({
      leaseExpiresAt: new Date(Date.now() - 1_000).toISOString(),
    }).where(eq(accountActionDeliveryJobs.id, result.job.id));
    const recovered = await claimNextPasswordResetDeliveryJob({ workerId: "queue-worker-b" });
    expect(recovered?.leaseToken).not.toBe(first?.leaseToken);
    expect(recovered?.job.attemptCount).toBe(2);

    expect(await finalizePasswordResetDeliveryJob({
      jobId: result.job.id,
      leaseToken: first?.leaseToken ?? "stale-lease",
      outcome: { status: "failed", errorCode: "stale-worker" },
    })).toBe(false);
    expect(await finalizePasswordResetDeliveryJob({
      jobId: result.job.id,
      leaseToken: recovered?.leaseToken ?? "replacement-lease",
      outcome: { status: "failed", errorCode: "replacement-worker" },
    })).toBe(true);

    const [stored] = await db.select({ status: accountActionDeliveryJobs.status, lastErrorCode: accountActionDeliveryJobs.lastErrorCode })
      .from(accountActionDeliveryJobs)
      .where(eq(accountActionDeliveryJobs.id, result.job.id));
    expect(stored).toEqual({ status: "failed", lastErrorCode: "replacement-worker" });
  });

  it("attaches only an action owned by the exact delivery job", async () => {
    const user = await createFixtureUser("Queue Correlation");
    const result = await enqueuePasswordResetDelivery({ userId: user.id, organizationId, expiresAt: deadline() });
    if (result.kind !== "enqueued") throw new Error("correlation job was suppressed");
    const claim = await claimNextPasswordResetDeliveryJob({ workerId: "queue-correlation-worker" });
    if (!claim) throw new Error("correlation job was not claimed");

    const action = await tryIssuePasswordReset({
      userId: user.id,
      recipientEmail: user.email,
      organizationId,
      expiresAt: deadline(),
      deliveryJobId: result.job.id,
      expectedCredentialGeneration: user.credentialGeneration,
    });
    if (action.kind !== "issued") throw new Error("correlation action was suppressed");
    expect(await attachPasswordResetActionToDeliveryJob({
      jobId: result.job.id,
      leaseToken: claim.leaseToken,
      actionRequestId: action.request.id,
    })).toBe(true);

    const [linked] = await db.select({ actionRequestId: accountActionDeliveryJobs.actionRequestId })
      .from(accountActionDeliveryJobs)
      .where(eq(accountActionDeliveryJobs.id, result.job.id));
    expect(linked?.actionRequestId).toBe(action.request.id);
    expect(await finalizePasswordResetDeliveryJob({
      jobId: result.job.id,
      leaseToken: claim.leaseToken,
      outcome: { status: "succeeded", actionRequestId: action.request.id, providerMessageId: "provider-message" },
    })).toBe(true);
  });

  it("preserves three still-usable links and rejects a fourth issuance", async () => {
    const user = await createFixtureUser("Queue Capacity");
    for (let index = 0; index < PASSWORD_RESET_PENDING_CAP; index += 1) {
      const issued = await issueAccountAction({
        userId: user.id,
        action: "password_reset",
        organizationId,
        recipientEmail: user.email,
        expiresAt: deadline(),
        preservePending: true,
      });
      expect(issued.request.status).toBe("pending");
    }
    await expect(issueAccountAction({
      userId: user.id,
      action: "password_reset",
      organizationId,
      recipientEmail: user.email,
      expiresAt: deadline(),
      preservePending: true,
    })).rejects.toBeInstanceOf(PasswordResetCapacityError);

    const pending = await db.select({ id: accountActionRequests.id })
      .from(accountActionRequests)
      .where(and(
        eq(accountActionRequests.userId, user.id),
        eq(accountActionRequests.action, "password_reset"),
        eq(accountActionRequests.status, "pending"),
      ));
    expect(pending).toHaveLength(PASSWORD_RESET_PENDING_CAP);
  });

  it("does not claim expired or exhausted intents and recovers them terminally", async () => {
    const user = await createFixtureUser("Queue Recovery");
    const exhaustedUser = await createFixtureUser("Queue Exhausted");
    const [expired] = await db.insert(accountActionDeliveryJobs).values({
      userId: user.id,
      organizationId,
      action: "password_reset",
      credentialGeneration: user.credentialGeneration,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      status: "pending",
      attemptCount: 0,
      nextAttemptAt: new Date(Date.now() - 60_000).toISOString(),
    }).returning();
    const exhaustedValues: typeof accountActionDeliveryJobs.$inferInsert = {
      userId: exhaustedUser.id,
      organizationId,
      action: "password_reset",
      credentialGeneration: exhaustedUser.credentialGeneration,
      expiresAt: deadline().toISOString(),
      status: "retry_scheduled",
      attemptCount: 4,
      nextAttemptAt: new Date(Date.now() - 60_000).toISOString(),
    };
    const [exhausted] = await db.insert(accountActionDeliveryJobs).values(exhaustedValues).returning();
    if (!expired || !exhausted) throw new Error("recovery fixtures were not created");

    expect(await claimNextPasswordResetDeliveryJob({ workerId: "queue-recovery-worker" })).toBeUndefined();
    expect(await recoverPasswordResetDeliveryJobs()).toBeGreaterThanOrEqual(2);
    const rows = await db.select({ id: accountActionDeliveryJobs.id, status: accountActionDeliveryJobs.status })
      .from(accountActionDeliveryJobs)
      .where(inArray(accountActionDeliveryJobs.id, [expired.id, exhausted.id]));
    expect(rows).toEqual(expect.arrayContaining([
      { id: expired.id, status: "failed" },
      { id: exhausted.id, status: "failed" },
    ]));
  });

  it("never persists a bearer token on queue or action rows", async () => {
    const user = await createFixtureUser("Queue Secret");
    const result = await enqueuePasswordResetDelivery({ userId: user.id, organizationId, expiresAt: deadline() });
    if (result.kind !== "enqueued") throw new Error("secret fixture job was suppressed");
    const claim = await claimNextPasswordResetDeliveryJob({ workerId: "queue-secret-worker" });
    if (!claim) throw new Error("secret fixture job was not claimed");
    const action = await tryIssuePasswordReset({
      userId: user.id,
      recipientEmail: user.email,
      organizationId,
      expiresAt: deadline(),
      deliveryJobId: result.job.id,
      expectedCredentialGeneration: user.credentialGeneration,
    });
    if (action.kind !== "issued") throw new Error("secret fixture action was suppressed");
    expect(action.token).toMatch(/^[0-9a-f]{64}\.[0-9a-f]{64}$/);
    expect(JSON.stringify(result.job)).not.toContain(action.token);
    expect(JSON.stringify(action.request)).not.toContain(action.token);
    await finalizePasswordResetDeliveryJob({
      jobId: result.job.id,
      leaseToken: claim.leaseToken,
      outcome: { status: "failed", errorCode: "test-cleanup" },
    });
  });
});
