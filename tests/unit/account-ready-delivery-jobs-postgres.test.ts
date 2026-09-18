/** PostgreSQL invariants for the automatic account-ready delivery intent. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { accountReadyDeliveryJobs } from "@shared/schema/account-ready-delivery-jobs";
import { bowlers, identityLinkEvents, profileClaimNotifications, users } from "@shared/schema";
import { getTestDb } from "../setup/test-db";
import { getBaselineOrgAId } from "../helpers";
import {
  ACCOUNT_READY_DELIVERY_MAX_ATTEMPTS,
} from "@shared/schema/account-ready-delivery-jobs";
import {
  claimNextAccountReadyDeliveryJob,
  finalizeAccountReadyDeliveryJob,
  getNextAccountReadyDeliveryAt,
  queueAccountReadyDeliveryJob,
  requeueAccountReadyDeliveryJob,
  recoverAccountReadyDeliveryJobs,
} from "../../server/storage/account-ready-delivery-jobs";
import { profileClaimReportTokenHashForEvent } from "../../server/storage/profile-claim-notifications";
import { linkUserToBowler } from "../../server/services/identity-link";
import { accountReadyDeliveryProductionDependencies } from "../../server/services/account-ready-delivery-worker";

const db = getTestDb();
const suffix = `${process.env.VITEST_POOL_ID ?? "0"}-${Date.now()}`;
let organizationId = 0;
const userIds: number[] = [];
const bowlerIds: number[] = [];
const eventIds: number[] = [];

beforeAll(async () => {
  organizationId = await getBaselineOrgAId();
});

afterAll(async () => {
  if (eventIds.length > 0) {
    await db.delete(identityLinkEvents).where(inArray(identityLinkEvents.id, eventIds));
  }
  if (userIds.length > 0) await db.delete(users).where(inArray(users.id, userIds));
  if (bowlerIds.length > 0) await db.delete(bowlers).where(inArray(bowlers.id, bowlerIds));
});

async function fixture(label: string) {
  const [bowler] = await db.insert(bowlers).values({
    name: `${label} Bowler ${suffix}`,
    email: `${label.toLowerCase()}-bowler-${suffix}@example.test`,
    organizationId,
    active: true,
  }).returning();
  if (!bowler) throw new Error("account-ready bowler fixture was not created");
  bowlerIds.push(bowler.id);
  const [user] = await db.insert(users).values({
    name: `${label} User ${suffix}`,
    email: `${label.toLowerCase()}-user-${suffix}@example.test`,
    password: "password-hash",
    role: "user",
    organizationId,
    bowlerId: null,
  }).returning();
  if (!user) throw new Error("account-ready user fixture was not created");
  userIds.push(user.id);
  return { user, bowler };
}

async function eventFor(userId: number, bowlerId: number) {
  const [event] = await db.insert(identityLinkEvents).values({
    organizationId,
    subjectUserId: userId,
    userId,
    bowlerId,
    newBowlerId: bowlerId,
    eventType: "link",
    source: "account-ready-test",
  }).returning();
  if (!event) throw new Error("account-ready event fixture was not created");
  eventIds.push(event.id);
  return event;
}

describe("account-ready delivery queue PostgreSQL boundaries", () => {
  it("does not suppress account-ready delivery when no profile-claim recipient exists", async () => {
    const { user, bowler } = await fixture("No Claim Notice");
    await db.update(users).set({ bowlerId: bowler.id }).where(eq(users.id, user.id));
    const event = await eventFor(user.id, bowler.id);
    const queued = await queueAccountReadyDeliveryJob({
      identityLinkEventId: event.id,
      userId: user.id,
      bowlerId: bowler.id,
      organizationId,
    });
    if (queued.kind !== "enqueued") throw new Error("no-claim fixture was coalesced");

    const target = await accountReadyDeliveryProductionDependencies.loadTarget(queued.job);
    expect(target?.toEmail).toBe(user.email);
    await db.update(accountReadyDeliveryJobs)
      .set({ nextAttemptAt: new Date(Date.now() + 60 * 60_000).toISOString() })
      .where(eq(accountReadyDeliveryJobs.id, queued.job.id));
  });

  it("uses the immutable profile-claim recipient when deciding whether to combine notices", async () => {
    const { user, bowler } = await fixture("Distinct Recipients");
    await db.update(users).set({ bowlerId: bowler.id }).where(eq(users.id, user.id));
    const event = await eventFor(user.id, bowler.id);
    const reportTokenHash = profileClaimReportTokenHashForEvent(event.id);
    if (!bowler.email) throw new Error("distinct-recipient bowler email was not created");
    await db.insert(profileClaimNotifications).values({
      identityLinkEventId: event.id,
      userId: user.id,
      bowlerId: bowler.id,
      organizationId,
      recipientEmail: bowler.email,
      recipientSource: "roster",
      recipientName: bowler.name,
      bowlerName: bowler.name,
      reportTokenHash,
      reportTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const queued = await queueAccountReadyDeliveryJob({
      identityLinkEventId: event.id,
      userId: user.id,
      bowlerId: bowler.id,
      organizationId,
    });
    if (queued.kind !== "enqueued") throw new Error("distinct-recipient fixture was coalesced");

    const target = await accountReadyDeliveryProductionDependencies.loadTarget(queued.job);
    expect(target?.toEmail).toBe(user.email);
    await db.update(accountReadyDeliveryJobs)
      .set({ nextAttemptAt: new Date(Date.now() + 60 * 60_000).toISOString() })
      .where(eq(accountReadyDeliveryJobs.id, queued.job.id));
  });

  it("suppresses only a viable combined notice and honors standalone resend", async () => {
    const { user, bowler } = await fixture("Combined Notice");
    await db.update(users).set({ bowlerId: bowler.id }).where(eq(users.id, user.id));
    await db.update(bowlers).set({ email: user.email }).where(eq(bowlers.id, bowler.id));
    const event = await eventFor(user.id, bowler.id);
    if (!bowler.email) throw new Error("combined-recipient bowler email was not created");
    await db.insert(profileClaimNotifications).values({
      identityLinkEventId: event.id,
      userId: user.id,
      bowlerId: bowler.id,
      organizationId,
      recipientEmail: user.email,
      recipientSource: "roster",
      recipientName: bowler.name,
      bowlerName: bowler.name,
      reportTokenHash: profileClaimReportTokenHashForEvent(event.id),
      reportTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const queued = await queueAccountReadyDeliveryJob({
      identityLinkEventId: event.id,
      userId: user.id,
      bowlerId: bowler.id,
      organizationId,
    });
    if (queued.kind !== "enqueued") throw new Error("combined-recipient fixture was coalesced");
    expect(await accountReadyDeliveryProductionDependencies.loadTarget(queued.job)).toBeUndefined();

    const requeued = await requeueAccountReadyDeliveryJob({ identityLinkEventId: event.id });
    if (!requeued) throw new Error("combined-recipient resend was not reopened");
    expect(requeued.standaloneDeliveryRequested).toBe(true);
    expect((await accountReadyDeliveryProductionDependencies.loadTarget(requeued))?.toEmail)
      .toBe(user.email);
    await db.update(accountReadyDeliveryJobs)
      .set({ nextAttemptAt: new Date(Date.now() + 60 * 60_000).toISOString() })
      .where(eq(accountReadyDeliveryJobs.id, queued.job.id));
  });

  it("claims two due intents concurrently without handing out the same row", async () => {
    const firstFixture = await fixture("Concurrent One");
    const secondFixture = await fixture("Concurrent Two");
    const firstEvent = await eventFor(firstFixture.user.id, firstFixture.bowler.id);
    const secondEvent = await eventFor(secondFixture.user.id, secondFixture.bowler.id);
    const [firstJob, secondJob] = await Promise.all([
      queueAccountReadyDeliveryJob({
        identityLinkEventId: firstEvent.id,
        userId: firstFixture.user.id,
        bowlerId: firstFixture.bowler.id,
        organizationId,
      }),
      queueAccountReadyDeliveryJob({
        identityLinkEventId: secondEvent.id,
        userId: secondFixture.user.id,
        bowlerId: secondFixture.bowler.id,
        organizationId,
      }),
    ]);
    if (firstJob.kind !== "enqueued" || secondJob.kind !== "enqueued") {
      throw new Error("concurrent queue fixtures were coalesced");
    }
    const claims = await Promise.all([
      claimNextAccountReadyDeliveryJob({ workerId: "concurrent-ready-a" }),
      claimNextAccountReadyDeliveryJob({ workerId: "concurrent-ready-b" }),
    ]);
    expect(claims[0]?.job.id).toBeTruthy();
    expect(claims[1]?.job.id).toBeTruthy();
    expect(new Set(claims.map((claim) => claim?.job.id)).size).toBe(2);
  });

  it("coalesces one event id and fences stale leases", async () => {
    const { user, bowler } = await fixture("Idempotent");
    const event = await eventFor(user.id, bowler.id);
    const first = await queueAccountReadyDeliveryJob({
      identityLinkEventId: event.id,
      userId: user.id,
      bowlerId: bowler.id,
      organizationId,
    });
    const second = await queueAccountReadyDeliveryJob({
      identityLinkEventId: event.id,
      userId: user.id,
      bowlerId: bowler.id,
      organizationId,
    });
    expect(first.kind).toBe("enqueued");
    expect(second).toMatchObject({ kind: "existing" });
    if (first.kind !== "enqueued") return;

    const claimed = await claimNextAccountReadyDeliveryJob({ workerId: "ready-worker-a" });
    expect(claimed?.job.id).toBe(first.job.id);
    expect(claimed?.job.attemptCount).toBe(1);
    await db.update(accountReadyDeliveryJobs)
      .set({ leaseExpiresAt: new Date(Date.now() - 1_000).toISOString() })
      .where(eq(accountReadyDeliveryJobs.id, first.job.id));
    const recoveredClaim = await claimNextAccountReadyDeliveryJob({ workerId: "ready-worker-b" });
    expect(recoveredClaim?.job.attemptCount).toBe(2);
    expect(await finalizeAccountReadyDeliveryJob({
      jobId: first.job.id,
      leaseToken: claimed?.leaseToken ?? "stale",
      outcome: { status: "succeeded", providerMessageId: "stale" },
    })).toBe(false);
    expect(await finalizeAccountReadyDeliveryJob({
      jobId: first.job.id,
      leaseToken: recoveredClaim?.leaseToken ?? "current",
      outcome: { status: "succeeded", providerMessageId: "current" },
    })).toBe(true);
  });

  it("marks an explicit resend standalone and renews an expired intent", async () => {
    const { user, bowler } = await fixture("Manual resend");
    const event = await eventFor(user.id, bowler.id);
    const queued = await queueAccountReadyDeliveryJob({
      identityLinkEventId: event.id,
      userId: user.id,
      bowlerId: bowler.id,
      organizationId,
      expiresAt: new Date(Date.now() - 1_000),
    }).catch(() => undefined);
    // The public enqueue contract rejects already-expired intents.  Create a
    // normal intent, then move it into the expired terminal state to model a
    // delivery that an administrator is reopening.
    const valid = queued ?? await queueAccountReadyDeliveryJob({
      identityLinkEventId: event.id,
      userId: user.id,
      bowlerId: bowler.id,
      organizationId,
    });
    if (valid.kind !== "enqueued") throw new Error("manual-resend fixture was coalesced");
    const oldExpiry = new Date(Date.now() - 1_000).toISOString();
    await db.update(accountReadyDeliveryJobs).set({
      status: "failed",
      completedAt: oldExpiry,
      expiresAt: oldExpiry,
      standaloneDeliveryRequested: false,
      lastErrorCode: "intent_expired",
    }).where(eq(accountReadyDeliveryJobs.id, valid.job.id));

    const requeued = await requeueAccountReadyDeliveryJob({ identityLinkEventId: event.id });
    expect(requeued?.status).toBe("pending");
    expect(requeued?.standaloneDeliveryRequested).toBe(true);
    expect(requeued && Date.parse(requeued.expiresAt)).toBeGreaterThan(Date.now());
  });

  it("recovers an exhausted intent and exposes an expired lease to the scheduler", async () => {
    const { user, bowler } = await fixture("Exhausted");
    const event = await eventFor(user.id, bowler.id);
    const queued = await queueAccountReadyDeliveryJob({
      identityLinkEventId: event.id,
      userId: user.id,
      bowlerId: bowler.id,
      organizationId,
    });
    if (queued.kind !== "enqueued") throw new Error("exhausted fixture was coalesced");
    await db.update(accountReadyDeliveryJobs).set({
      status: "processing",
      attemptCount: ACCOUNT_READY_DELIVERY_MAX_ATTEMPTS,
      leaseOwner: "dead-worker",
      leaseToken: "dead-token",
      leaseExpiresAt: new Date(Date.now() - 1_000).toISOString(),
    }).where(eq(accountReadyDeliveryJobs.id, queued.job.id));
    expect(await getNextAccountReadyDeliveryAt()).toBeInstanceOf(Date);
    expect(await recoverAccountReadyDeliveryJobs()).toBeGreaterThanOrEqual(1);
    const [row] = await db.select({ status: accountReadyDeliveryJobs.status })
      .from(accountReadyDeliveryJobs)
      .where(eq(accountReadyDeliveryJobs.id, queued.job.id));
    expect(row?.status).toBe("failed");
    await db.update(accountReadyDeliveryJobs).set({
      completedAt: new Date(Date.now() - 31 * 24 * 60 * 60_000).toISOString(),
    }).where(eq(accountReadyDeliveryJobs.id, queued.job.id));
    await recoverAccountReadyDeliveryJobs();
    expect(await db.select({ id: accountReadyDeliveryJobs.id })
      .from(accountReadyDeliveryJobs)
      .where(eq(accountReadyDeliveryJobs.id, queued.job.id))).toHaveLength(0);
  });

  it("rolls back the link event and queue row with the surrounding transaction", async () => {
    const { user, bowler } = await fixture("Rollback");
    await expect(db.transaction(async (tx) => {
      await linkUserToBowler({
        organizationId,
        userId: user.id,
        bowlerId: bowler.id,
        source: "bowler-post-create-email-auto-link",
        queueAccountReadyEmail: true,
      }, tx);
      throw new Error("outer transaction rollback");
    })).rejects.toThrow("outer transaction rollback");

    const [userRow] = await db.select({ bowlerId: users.bowlerId }).from(users).where(eq(users.id, user.id));
    expect(userRow?.bowlerId).toBeNull();
    expect(await db.select({ id: identityLinkEvents.id }).from(identityLinkEvents)
      .where(eq(identityLinkEvents.subjectUserId, user.id))).toHaveLength(0);
    expect(await db.select({ id: accountReadyDeliveryJobs.id }).from(accountReadyDeliveryJobs)
      .where(eq(accountReadyDeliveryJobs.userId, user.id))).toHaveLength(0);
  });

  it("suppresses an old event after the same user is linked again", async () => {
    const { user, bowler } = await fixture("Stale");
    await db.update(users).set({ bowlerId: bowler.id }).where(eq(users.id, user.id));
    const oldEvent = await eventFor(user.id, bowler.id);
    await new Promise((resolve) => setTimeout(resolve, 2));
    const currentEvent = await eventFor(user.id, bowler.id);
    const queued = await queueAccountReadyDeliveryJob({
      identityLinkEventId: oldEvent.id,
      userId: user.id,
      bowlerId: bowler.id,
      organizationId,
    });
    if (queued.kind !== "enqueued") throw new Error("stale fixture was coalesced");
    const target = await accountReadyDeliveryProductionDependencies.loadTarget(queued.job);
    expect(currentEvent.id).toBeGreaterThan(oldEvent.id);
    expect(target).toBeUndefined();
  });

  it("deletes queued intents when their identity event is removed", async () => {
    const { user, bowler } = await fixture("Cascade");
    const event = await eventFor(user.id, bowler.id);
    const queued = await queueAccountReadyDeliveryJob({
      identityLinkEventId: event.id,
      userId: user.id,
      bowlerId: bowler.id,
      organizationId,
    });
    if (queued.kind !== "enqueued") throw new Error("cascade fixture was coalesced");
    await db.delete(identityLinkEvents).where(eq(identityLinkEvents.id, event.id));
    expect(await db.select({ id: accountReadyDeliveryJobs.id }).from(accountReadyDeliveryJobs)
      .where(eq(accountReadyDeliveryJobs.id, queued.job.id))).toHaveLength(0);
  });
});
