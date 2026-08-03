import { randomUUID } from "node:crypto";
import { and, eq, or, sql } from "drizzle-orm";
import {
  WEBHOOK_EVENT_MAX_ATTEMPTS,
  WEBHOOK_EVENT_MAX_LEASE_MS,
  locations,
  locationSquareCredentialsSchema,
  webhookEvents,
  type WebhookEvent,
  type WebhookEventErrorClassification,
} from "@shared/schema";
import { db } from "../db.js";
import { encrypt } from "../utils/crypto.js";

export class WebhookLocationMappingError extends Error {
  constructor(readonly code: "LOCATION_NOT_FOUND" | "LOCATION_AMBIGUOUS" | "APPLICATION_MISMATCH") {
    super(code);
    this.name = "WebhookLocationMappingError";
  }
}

export class WebhookDuplicateMismatchError extends Error {
  constructor() {
    super("provider event identity was reused with different immutable evidence");
    this.name = "WebhookDuplicateMismatchError";
  }
}

export interface IngestSquareWebhookEventInput {
  providerEventId: string;
  eventType: string;
  providerCreatedAt: string;
  providerApplicationId: string;
  providerMerchantId: string;
  providerLocationId: string;
  providerObjectType: string;
  providerObjectId: string;
  providerPaymentId: string | null;
  providerObjectVersion: number | null;
  providerObjectUpdatedAt: string | null;
  providerApiVersion: string;
  payloadHash: string;
  rawPayload: string;
  ignored: boolean;
  now?: Date;
}

export interface IngestSquareWebhookEventResult {
  event: WebhookEvent;
  duplicate: boolean;
}

function duplicateMatches(existing: WebhookEvent, input: IngestSquareWebhookEventInput): boolean {
  return existing.provider === "square"
    && existing.providerEventId === input.providerEventId
    && existing.eventType === input.eventType
    && new Date(existing.providerCreatedAt).getTime() === new Date(input.providerCreatedAt).getTime()
    && existing.providerApplicationId === input.providerApplicationId
    && existing.providerMerchantId === input.providerMerchantId
    && existing.providerLocationId === input.providerLocationId
    && existing.providerObjectType === input.providerObjectType
    && existing.providerObjectId === input.providerObjectId
    && existing.providerPaymentId === input.providerPaymentId
    && existing.providerObjectVersion === input.providerObjectVersion
    && (
      existing.providerObjectUpdatedAt === input.providerObjectUpdatedAt
      || (
        existing.providerObjectUpdatedAt !== null
        && input.providerObjectUpdatedAt !== null
        && new Date(existing.providerObjectUpdatedAt).getTime()
          === new Date(input.providerObjectUpdatedAt).getTime()
      )
    )
    && existing.providerApiVersion === input.providerApiVersion
    && existing.payloadHash === input.payloadHash;
}

/** Durably records one verified Square event and converges concurrent delivery. */
export async function ingestSquareWebhookEvent(
  input: IngestSquareWebhookEventInput,
): Promise<IngestSquareWebhookEventResult> {
  const now = (input.now ?? new Date()).toISOString();
  return db.transaction(async (tx) => {
    const [previouslyRecorded] = await tx
      .select()
      .from(webhookEvents)
      .where(and(
        eq(webhookEvents.provider, "square"),
        eq(webhookEvents.providerEventId, input.providerEventId),
      ))
      .limit(1);
    if (previouslyRecorded) {
      if (!duplicateMatches(previouslyRecorded, input)) {
        throw new WebhookDuplicateMismatchError();
      }
      return { event: previouslyRecorded, duplicate: true };
    }

    const candidates = await tx
      .select({
        id: locations.id,
        organizationId: locations.organizationId,
        squareCredentials: locations.squareCredentials,
      })
      .from(locations)
      .where(sql`btrim(${locations.squareCredentials} ->> 'locationId') = ${input.providerLocationId}`)
      .orderBy(locations.id)
      .limit(2)
      .for("share");

    if (candidates.length === 0) throw new WebhookLocationMappingError("LOCATION_NOT_FOUND");
    if (candidates.length !== 1) throw new WebhookLocationMappingError("LOCATION_AMBIGUOUS");
    const candidate = candidates[0];
    if (!candidate) throw new WebhookLocationMappingError("LOCATION_NOT_FOUND");
    const credentials = locationSquareCredentialsSchema.safeParse(candidate.squareCredentials);
    if (
      !credentials.success
      || credentials.data?.appId?.trim() !== input.providerApplicationId
    ) {
      throw new WebhookLocationMappingError("APPLICATION_MISMATCH");
    }

    const [created] = await tx
      .insert(webhookEvents)
      .values({
        provider: "square",
        providerEventId: input.providerEventId,
        eventType: input.eventType,
        providerCreatedAt: input.providerCreatedAt,
        receivedAt: now,
        organizationId: candidate.organizationId,
        locationId: candidate.id,
        providerApplicationId: input.providerApplicationId,
        providerMerchantId: input.providerMerchantId,
        providerLocationId: input.providerLocationId,
        providerObjectType: input.providerObjectType,
        providerObjectId: input.providerObjectId,
        providerPaymentId: input.providerPaymentId,
        providerObjectVersion: input.providerObjectVersion,
        providerObjectUpdatedAt: input.providerObjectUpdatedAt,
        providerApiVersion: input.providerApiVersion,
        payloadHash: input.payloadHash,
        encryptedPayload: encrypt(input.rawPayload),
        status: input.ignored ? "ignored" : "pending",
        errorClassification: input.ignored ? "processing" : null,
        errorCode: input.ignored ? "EVENT_TYPE_NOT_SUPPORTED" : null,
        processedAt: input.ignored ? now : null,
        completedAt: input.ignored ? now : null,
        updatedAt: now,
      })
      .onConflictDoNothing({
        target: [webhookEvents.provider, webhookEvents.providerEventId],
      })
      .returning();
    if (created) return { event: created, duplicate: false };

    // A concurrent transaction won the provider/event unique constraint after
    // our initial read. Compare its committed immutable evidence before acking.
    const [existing] = await tx
      .select()
      .from(webhookEvents)
      .where(and(
        eq(webhookEvents.provider, "square"),
        eq(webhookEvents.providerEventId, input.providerEventId),
      ))
      .limit(1);
    if (!existing || !duplicateMatches(existing, input)) {
      throw new WebhookDuplicateMismatchError();
    }
    if (
      existing.organizationId !== candidate.organizationId
      || existing.locationId !== candidate.id
    ) {
      throw new WebhookDuplicateMismatchError();
    }
    return { event: existing, duplicate: true };
  });
}

export interface ClaimWebhookEventInput {
  organizationId: number;
  eventId: string;
  leaseOwner: string;
  leaseDurationMs: number;
  now?: Date;
}

/** Explicit ID claim only. Phase 4A-1 has no scan, sweep, timer, or caller. */
export async function claimWebhookEvent(
  input: ClaimWebhookEventInput,
): Promise<WebhookEvent | undefined> {
  if (!input.leaseOwner.trim() || input.leaseOwner.length > 128) {
    throw new Error("webhook lease owner is invalid");
  }
  if (
    !Number.isInteger(input.leaseDurationMs)
    || input.leaseDurationMs <= 0
    || input.leaseDurationMs > WEBHOOK_EVENT_MAX_LEASE_MS
  ) {
    throw new Error("webhook lease duration is invalid");
  }
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const leaseToken = randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + input.leaseDurationMs).toISOString();
  const [claimed] = await db
    .update(webhookEvents)
    .set({
      status: "processing",
      attemptCount: sql`${webhookEvents.attemptCount} + 1`,
      nextAttemptAt: null,
      leaseOwner: input.leaseOwner,
      leaseToken,
      leaseExpiresAt,
      processedAt: null,
      errorClassification: null,
      errorCode: null,
      updatedAt: nowIso,
    })
    .where(and(
      eq(webhookEvents.id, input.eventId),
      eq(webhookEvents.organizationId, input.organizationId),
      sql`${webhookEvents.attemptCount} < ${WEBHOOK_EVENT_MAX_ATTEMPTS}`,
      or(
        eq(webhookEvents.status, "pending"),
        and(
          eq(webhookEvents.status, "retry_scheduled"),
          sql`${webhookEvents.nextAttemptAt} <= ${nowIso}`,
        ),
        and(
          eq(webhookEvents.status, "processing"),
          sql`${webhookEvents.leaseExpiresAt} <= ${nowIso}`,
        ),
      ),
    ))
    .returning();
  return claimed;
}

interface LeasedWebhookEventInput {
  organizationId: number;
  eventId: string;
  leaseToken: string;
  now?: Date;
}

function assertSanitizedErrorCode(value: string): void {
  if (!/^[A-Z][A-Z0-9_]{0,95}$/.test(value)) {
    throw new Error("webhook error code is not sanitized");
  }
}

export async function completeWebhookEvent(
  input: LeasedWebhookEventInput & {
    outcome: "processed" | "ignored" | "failed";
    errorClassification?: WebhookEventErrorClassification;
    errorCode?: string;
  },
): Promise<WebhookEvent | undefined> {
  const now = (input.now ?? new Date()).toISOString();
  const hasError = input.errorClassification !== undefined || input.errorCode !== undefined;
  if (hasError !== (input.errorClassification !== undefined && input.errorCode !== undefined)) {
    throw new Error("webhook completion error fields must be provided together");
  }
  if (input.outcome === "failed" && !hasError) {
    throw new Error("failed webhook completion requires a sanitized error");
  }
  if (input.outcome === "processed" && hasError) {
    throw new Error("processed webhook completion cannot retain an error");
  }
  if (input.errorCode !== undefined) assertSanitizedErrorCode(input.errorCode);
  const [completed] = await db
    .update(webhookEvents)
    .set({
      status: input.outcome,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      errorClassification: input.errorClassification ?? null,
      errorCode: input.errorCode ?? null,
      processedAt: now,
      completedAt: now,
      updatedAt: now,
    })
    .where(and(
      eq(webhookEvents.id, input.eventId),
      eq(webhookEvents.organizationId, input.organizationId),
      eq(webhookEvents.status, "processing"),
      eq(webhookEvents.leaseToken, input.leaseToken),
    ))
    .returning();
  return completed;
}

export async function scheduleWebhookEventRetry(
  input: LeasedWebhookEventInput & {
    nextAttemptAt: Date;
    errorClassification: WebhookEventErrorClassification;
    errorCode: string;
  },
): Promise<WebhookEvent | undefined> {
  const now = input.now ?? new Date();
  if (input.nextAttemptAt.getTime() <= now.getTime()) {
    throw new Error("webhook retry must be in the future");
  }
  assertSanitizedErrorCode(input.errorCode);
  const nowIso = now.toISOString();
  const [scheduled] = await db
    .update(webhookEvents)
    .set({
      status: "retry_scheduled",
      nextAttemptAt: input.nextAttemptAt.toISOString(),
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      errorClassification: input.errorClassification,
      errorCode: input.errorCode,
      processedAt: nowIso,
      updatedAt: nowIso,
    })
    .where(and(
      eq(webhookEvents.id, input.eventId),
      eq(webhookEvents.organizationId, input.organizationId),
      eq(webhookEvents.status, "processing"),
      eq(webhookEvents.leaseToken, input.leaseToken),
    ))
    .returning();
  return scheduled;
}

export async function getWebhookEventForOrganization(
  organizationId: number,
  eventId: string,
): Promise<WebhookEvent | undefined> {
  const [event] = await db
    .select()
    .from(webhookEvents)
    .where(and(
      eq(webhookEvents.id, eventId),
      eq(webhookEvents.organizationId, organizationId),
    ))
    .limit(1);
  return event;
}
