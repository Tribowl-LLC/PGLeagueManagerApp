import { and, eq } from "drizzle-orm";
import {
  accountActionRequests,
  accountActionDeliveryJobs,
  accountEmailDeliveryEvents,
  type AccountEmailDeliveryEvent,
  type AccountEmailDeliveryEventType,
} from "@shared/schema";
import { db } from "../db.js";

export interface AccountEmailDeliveryCorrelation {
  accountActionId: number;
  accountDeliveryJobId: number;
}

export interface IngestAccountEmailDeliveryEventInput extends AccountEmailDeliveryCorrelation {
  providerEventId: string;
  providerMessageId: string | null;
  eventType: AccountEmailDeliveryEventType;
  providerEventAt: string;
  receivedAt?: Date;
}

export interface IngestAccountEmailDeliveryEventResult {
  event?: AccountEmailDeliveryEvent;
  duplicate: boolean;
  ignored: boolean;
}

/**
 * The queue owns delivery-job records. Require both sides of the foreign-key
 * pair to resolve and require the action's immutable deliveryJobId to match
 * the provider correlation. Events that cannot be tied to a real action/job
 * pair are discarded before they reach the evidence table.
 */
export async function isKnownAccountEmailDeliveryCorrelation(
  correlation: AccountEmailDeliveryCorrelation,
): Promise<boolean> {
  if (!Number.isSafeInteger(correlation.accountActionId) || correlation.accountActionId <= 0) {
    return false;
  }
  if (!Number.isSafeInteger(correlation.accountDeliveryJobId) || correlation.accountDeliveryJobId <= 0) {
    return false;
  }

  const [action] = await db
    .select({
      id: accountActionRequests.id,
      deliveryJobId: accountActionRequests.deliveryJobId,
      userId: accountActionRequests.userId,
      action: accountActionRequests.action,
      jobUserId: accountActionDeliveryJobs.userId,
      jobAction: accountActionDeliveryJobs.action,
    })
    .from(accountActionRequests)
    .innerJoin(
      accountActionDeliveryJobs,
      eq(accountActionDeliveryJobs.id, correlation.accountDeliveryJobId),
    )
    .where(and(
      eq(accountActionRequests.id, correlation.accountActionId),
      eq(accountActionRequests.action, "password_reset"),
      eq(accountActionDeliveryJobs.action, "password_reset"),
    ))
    .limit(1);
  return action !== undefined
    && action.action === "password_reset"
    && action.jobAction === "password_reset"
    && action.userId === action.jobUserId
    && action.deliveryJobId === correlation.accountDeliveryJobId;
}

/**
 * Persist one already authenticated SendGrid event. The unique provider event
 * ID makes retries idempotent and the pre-insert correlation check prevents
 * arbitrary provider payloads from becoming application evidence.
 */
export async function ingestAccountEmailDeliveryEvent(
  input: IngestAccountEmailDeliveryEventInput,
): Promise<IngestAccountEmailDeliveryEventResult> {
  // Validate the immutable action/job pair before consulting the event ID.
  // This keeps unknown provider payloads out of the evidence path and avoids
  // turning the deduplication key into a probe for an existing event.
  if (!(await isKnownAccountEmailDeliveryCorrelation(input))) {
    return { duplicate: false, ignored: true };
  }

  const [existing] = await db
    .select()
    .from(accountEmailDeliveryEvents)
    .where(eq(accountEmailDeliveryEvents.providerEventId, input.providerEventId))
    .limit(1);
  if (existing) {
    // A provider event ID is globally unique. If a malformed or replayed
    // payload pairs it with a different action/job, acknowledge it as
    // ignored without returning the existing row or overwriting evidence.
    const sameCorrelation = existing.accountActionId === input.accountActionId
      && existing.accountDeliveryJobId === input.accountDeliveryJobId;
    return sameCorrelation
      ? { event: existing, duplicate: true, ignored: false }
      : { duplicate: true, ignored: true };
  }

  const [created] = await db
    .insert(accountEmailDeliveryEvents)
    .values({
      providerEventId: input.providerEventId,
      providerMessageId: input.providerMessageId,
      accountActionId: input.accountActionId,
      accountDeliveryJobId: input.accountDeliveryJobId,
      eventType: input.eventType,
      providerEventAt: input.providerEventAt,
      ...(input.receivedAt ? { receivedAt: input.receivedAt.toISOString() } : {}),
    })
    .onConflictDoNothing({ target: accountEmailDeliveryEvents.providerEventId })
    .returning();
  if (created) return { event: created, duplicate: false, ignored: false };

  // A concurrent webhook request won the unique constraint. Treat it as the
  // same event only after reading the committed row; never overwrite its
  // correlation or provider metadata.
  const [concurrent] = await db
    .select()
    .from(accountEmailDeliveryEvents)
    .where(and(
      eq(accountEmailDeliveryEvents.providerEventId, input.providerEventId),
      eq(accountEmailDeliveryEvents.accountActionId, input.accountActionId),
      eq(accountEmailDeliveryEvents.accountDeliveryJobId, input.accountDeliveryJobId),
    ))
    .limit(1);
  if (concurrent) return { event: concurrent, duplicate: true, ignored: false };

  // The provider event ID was already recorded against a different
  // correlation. Do not reveal that detail to the caller or mutate evidence.
  return { duplicate: true, ignored: true };
}
