/**
 * PostgreSQL coverage for authenticated SendGrid delivery evidence.
 *
 * These checks exercise the foreign-key correlation and provider-event
 * uniqueness constraints against the same schema used in production. In
 * particular, a retry may report an earlier action from the same delivery
 * job after the job's mutable latest-action pointer has moved forward.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { getTestDb } from "../setup/test-db";
import { getBaselineOrgAId } from "../helpers";
import {
  accountActionDeliveryJobs,
  accountActionRequests,
  accountEmailDeliveryEvents,
  users,
} from "@shared/schema";
import {
  ingestAccountEmailDeliveryEvent,
  isKnownAccountEmailDeliveryCorrelation,
} from "../../server/storage/account-email-delivery-events";
import { issueAccountAction } from "../../server/storage/account-action-requests";

const db = getTestDb();
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const userIds: number[] = [];
let organizationId = 0;

async function createFixtureUser(label: string) {
  const [user] = await db
    .insert(users)
    .values({
      name: `${label} ${suffix}`,
      email: `${label.toLowerCase().replaceAll(" ", "-")}-${suffix}@example.com`,
      password: "old-password-hash",
      role: "user",
      organizationId,
    })
    .returning();
  if (!user) throw new Error("delivery-event fixture user was not created");
  userIds.push(user.id);
  return user;
}

async function createFixtureJob(userId: number) {
  const [job] = await db
    .insert(accountActionDeliveryJobs)
    .values({
      userId,
      organizationId,
      action: "password_reset",
      credentialGeneration: 0,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      status: "pending",
      attemptCount: 0,
      nextAttemptAt: new Date().toISOString(),
    })
    .returning();
  if (!job) throw new Error("delivery-event fixture job was not created");
  return job;
}

describe("account email delivery event storage", () => {
  beforeAll(async () => {
    organizationId = await getBaselineOrgAId();
  });

  afterAll(async () => {
    if (userIds.length > 0) {
      await db.delete(users).where(inArray(users.id, userIds));
    }
  });

  it("accepts a late earlier-attempt action tied to the immutable job and deduplicates retries", async () => {
    const user = await createFixtureUser("Delivery Event Retry");
    const job = await createFixtureJob(user.id);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

    const firstAction = await issueAccountAction({
      userId: user.id,
      action: "password_reset",
      organizationId,
      recipientEmail: user.email,
      expiresAt,
      deliveryJobId: job.id,
      preservePending: true,
    });
    const secondAction = await issueAccountAction({
      userId: user.id,
      action: "password_reset",
      organizationId,
      recipientEmail: user.email,
      expiresAt,
      deliveryJobId: job.id,
      preservePending: true,
    });

    await db
      .update(accountActionDeliveryJobs)
      .set({ actionRequestId: secondAction.request.id })
      .where(eq(accountActionDeliveryJobs.id, job.id));

    expect(await isKnownAccountEmailDeliveryCorrelation({
      accountActionId: firstAction.request.id,
      accountDeliveryJobId: job.id,
    })).toBe(true);

    const input = {
      providerEventId: `sg-event-retry-${suffix}`,
      providerMessageId: `sg-message-retry-${suffix}`,
      accountActionId: firstAction.request.id,
      accountDeliveryJobId: job.id,
      eventType: "delivered" as const,
      providerEventAt: new Date().toISOString(),
    };
    const created = await ingestAccountEmailDeliveryEvent(input);
    expect(created).toMatchObject({ duplicate: false, ignored: false });
    expect(created.event?.accountActionId).toBe(firstAction.request.id);

    const duplicate = await ingestAccountEmailDeliveryEvent(input);
    expect(duplicate).toMatchObject({ duplicate: true, ignored: false });
    expect(duplicate.event?.accountActionId).toBe(firstAction.request.id);

    const [eventRows, actionRows] = await Promise.all([
      db
        .select()
        .from(accountEmailDeliveryEvents)
        .where(eq(accountEmailDeliveryEvents.providerEventId, input.providerEventId)),
      db
        .select()
        .from(accountActionRequests)
        .where(and(
          eq(accountActionRequests.deliveryJobId, job.id),
          eq(accountActionRequests.userId, user.id),
        )),
    ]);
    expect(eventRows).toHaveLength(1);
    expect(actionRows).toHaveLength(2);
  });

  it("rejects a job mismatch and does not reuse an event ID for another correlation", async () => {
    const user = await createFixtureUser("Delivery Event Correlation");
    const job = await createFixtureJob(user.id);
    const otherJob = await db
      .insert(accountActionDeliveryJobs)
      .values({
        userId: user.id,
        organizationId,
        action: "password_reset",
        credentialGeneration: 0,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        status: "failed",
        attemptCount: 1,
        nextAttemptAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      })
      .returning();
    const mismatchedJob = otherJob[0];
    if (!mismatchedJob) throw new Error("mismatched delivery-event fixture job was not created");

    const action = await issueAccountAction({
      userId: user.id,
      action: "password_reset",
      organizationId,
      recipientEmail: user.email,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      deliveryJobId: job.id,
      preservePending: true,
    });

    expect(await isKnownAccountEmailDeliveryCorrelation({
      accountActionId: action.request.id,
      accountDeliveryJobId: mismatchedJob.id,
    })).toBe(false);

    const input = {
      providerEventId: `sg-event-correlation-${suffix}`,
      providerMessageId: null,
      accountActionId: action.request.id,
      accountDeliveryJobId: job.id,
      eventType: "bounce" as const,
      providerEventAt: new Date().toISOString(),
    };
    await expect(ingestAccountEmailDeliveryEvent({
      ...input,
      accountDeliveryJobId: mismatchedJob.id,
    })).resolves.toMatchObject({ duplicate: false, ignored: true });

    await expect(ingestAccountEmailDeliveryEvent(input)).resolves.toMatchObject({
      duplicate: false,
      ignored: false,
    });
    await expect(ingestAccountEmailDeliveryEvent({
      ...input,
      accountActionId: action.request.id,
      accountDeliveryJobId: mismatchedJob.id,
    })).resolves.toMatchObject({ duplicate: false, ignored: true });
  });
});
