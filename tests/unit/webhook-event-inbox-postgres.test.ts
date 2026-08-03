import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { locations, organizations, webhookEvents } from "@shared/schema";
import { deleteOrganization } from "../../server/storage/organizations";
import {
  WebhookDuplicateMismatchError,
  claimWebhookEvent,
  completeWebhookEvent,
  getWebhookEventForOrganization,
  ingestSquareWebhookEvent,
  scheduleWebhookEventRetry,
  type IngestSquareWebhookEventInput,
} from "../../server/storage/webhook-events";
import {
  deleteLocation,
  LocationWebhookEvidenceExistsError,
} from "../../server/storage/locations";
import { decrypt } from "../../server/utils/crypto";
import { getTestDb } from "../setup/test-db";

const db = getTestDb();
const suffix = process.env.VITEST_POOL_ID ?? "0";
const slugs = [
  `webhook-inbox-a-${suffix}`,
  `webhook-inbox-b-${suffix}`,
  `webhook-inbox-teardown-${suffix}`,
] as const;
let organizationAId: number;
let organizationBId: number;
let locationAId: number;

function input(overrides: Partial<IngestSquareWebhookEventInput> = {}): IngestSquareWebhookEventInput {
  const rawPayload = overrides.rawPayload ?? JSON.stringify({
    fixture: "encrypted-webhook-evidence",
    event: overrides.providerEventId ?? "event-inbox-fixture",
  });
  return {
    providerEventId: "event-inbox-fixture",
    eventType: "refund.updated",
    providerCreatedAt: "2026-08-03T12:00:00.000Z",
    providerApplicationId: "app-inbox-a",
    providerMerchantId: "merchant-inbox-a",
    providerLocationId: "provider-location-inbox-a",
    providerObjectType: "refund",
    providerObjectId: "refund-inbox-fixture",
    providerPaymentId: "payment-inbox-fixture",
    providerObjectVersion: 2,
    providerObjectUpdatedAt: "2026-08-03T11:59:00.000Z",
    providerApiVersion: "2026-05-20",
    payloadHash: createHash("sha256").update(rawPayload).digest("hex"),
    rawPayload,
    ignored: false,
    now: new Date("2026-08-03T12:01:00.000Z"),
    ...overrides,
  };
}

beforeAll(async () => {
  const leftovers = await db.select({ id: organizations.id })
    .from(organizations)
    .where(inArray(organizations.slug, [...slugs]));
  for (const leftover of leftovers) {
    await deleteOrganization(leftover.id);
  }
  const [organizationA, organizationB] = await db.insert(organizations).values([
    { name: "Webhook Inbox A", slug: slugs[0] },
    { name: "Webhook Inbox B", slug: slugs[1] },
  ]).returning({ id: organizations.id });
  if (!organizationA || !organizationB) throw new Error("webhook organizations were not created");
  organizationAId = organizationA.id;
  organizationBId = organizationB.id;
  const [locationA] = await db.insert(locations).values({
    name: "Webhook Inbox Location A",
    organizationId: organizationAId,
    squareCredentials: {
      appId: "app-inbox-a",
      locationId: "provider-location-inbox-a",
    },
  }).returning({ id: locations.id });
  if (!locationA) throw new Error("webhook location was not created");
  locationAId = locationA.id;
  await db.insert(locations).values({
    name: "Webhook Inbox Location B",
    organizationId: organizationBId,
    squareCredentials: {
      appId: "app-inbox-b",
      locationId: "provider-location-inbox-b",
    },
  });
});

afterAll(async () => {
  if (organizationAId) {
    await deleteOrganization(organizationAId);
  }
  if (organizationBId) {
    await deleteOrganization(organizationBId);
  }
});

describe("durable webhook inbox PostgreSQL boundaries", () => {
  it("converges concurrent duplicate insertion and encrypts the exact payload", async () => {
    const eventInput = input({ providerEventId: "event-concurrent-fixture" });
    const [left, right] = await Promise.all([
      ingestSquareWebhookEvent(eventInput),
      ingestSquareWebhookEvent(eventInput),
    ]);

    expect(left.event.id).toBe(right.event.id);
    expect([left.duplicate, right.duplicate].sort()).toEqual([false, true]);
    const [stored] = await db.select().from(webhookEvents).where(eq(
      webhookEvents.providerEventId,
      eventInput.providerEventId,
    ));
    expect(stored).toMatchObject({
      organizationId: organizationAId,
      locationId: locationAId,
      status: "pending",
      attemptCount: 0,
      providerObjectVersion: 2,
    });
    expect(stored?.encryptedPayload).not.toContain("encrypted-webhook-evidence");
    expect(decrypt(stored?.encryptedPayload ?? "")).toBe(eventInput.rawPayload);
  });

  it("rejects event-ID reuse with different evidence", async () => {
    const first = input({ providerEventId: "event-conflict-fixture" });
    await ingestSquareWebhookEvent(first);
    const rawPayload = `${first.rawPayload} `;
    await expect(ingestSquareWebhookEvent(input({
      providerEventId: first.providerEventId,
      rawPayload,
      payloadHash: createHash("sha256").update(rawPayload).digest("hex"),
    }))).rejects.toBeInstanceOf(WebhookDuplicateMismatchError);
  });

  it("acknowledges an exact delayed duplicate from its durable mapping", async () => {
    const eventInput = input({ providerEventId: "event-delayed-duplicate-fixture" });
    const first = await ingestSquareWebhookEvent(eventInput);
    await db.update(locations).set({
      squareCredentials: {
        appId: "app-settings-changed-after-ingest",
        locationId: "provider-location-settings-changed",
      },
    }).where(eq(locations.id, locationAId));
    try {
      const duplicate = await ingestSquareWebhookEvent(eventInput);
      expect(duplicate).toMatchObject({ duplicate: true });
      expect(duplicate.event.id).toBe(first.event.id);
      expect(duplicate.event.organizationId).toBe(organizationAId);
      expect(duplicate.event.locationId).toBe(locationAId);
    } finally {
      await db.update(locations).set({
        squareCredentials: {
          appId: "app-inbox-a",
          locationId: "provider-location-inbox-a",
        },
      }).where(eq(locations.id, locationAId));
    }
  });

  it("fails closed for missing, cross-application, and ambiguous location mappings", async () => {
    await expect(ingestSquareWebhookEvent(input({
      providerEventId: "event-location-missing",
      providerLocationId: "provider-location-missing",
    }))).rejects.toMatchObject({ code: "LOCATION_NOT_FOUND" });

    await expect(ingestSquareWebhookEvent(input({
      providerEventId: "event-application-mismatch",
      providerApplicationId: "app-inbox-b",
    }))).rejects.toMatchObject({ code: "APPLICATION_MISMATCH" });

    const [ambiguous] = await db.insert(locations).values({
      name: "Webhook Ambiguous Location",
      organizationId: organizationBId,
      squareCredentials: {
        appId: "app-inbox-a",
        locationId: "provider-location-inbox-a",
      },
    }).returning({ id: locations.id });
    try {
      await expect(ingestSquareWebhookEvent(input({
        providerEventId: "event-location-ambiguous",
      }))).rejects.toMatchObject({ code: "LOCATION_AMBIGUOUS" });
    } finally {
      if (ambiguous) await db.delete(locations).where(eq(locations.id, ambiguous.id));
    }
  });

  it("retains webhook evidence and rejects ordinary location deletion cleanly", async () => {
    const retained = await ingestSquareWebhookEvent(input({
      providerEventId: "event-location-retention-fixture",
    }));

    await expect(deleteLocation(locationAId))
      .rejects.toBeInstanceOf(LocationWebhookEvidenceExistsError);
    expect((await db.select({ id: locations.id }).from(locations)
      .where(eq(locations.id, locationAId)))[0]?.id).toBe(locationAId);
    expect((await db.select({ id: webhookEvents.id }).from(webhookEvents)
      .where(eq(webhookEvents.id, retained.event.id)))[0]?.id).toBe(retained.event.id);
  });

  it("removes retained webhook evidence during atomic full-tenant teardown", async () => {
    const [organization] = await db.insert(organizations).values({
      name: "Webhook Inbox Teardown",
      slug: slugs[2],
    }).returning({ id: organizations.id });
    if (!organization) throw new Error("teardown organization was not created");
    const [location] = await db.insert(locations).values({
      name: "Webhook Inbox Teardown Location",
      organizationId: organization.id,
      squareCredentials: {
        appId: "app-inbox-teardown",
        locationId: "provider-location-inbox-teardown",
      },
    }).returning({ id: locations.id });
    if (!location) throw new Error("teardown location was not created");
    const ingested = await ingestSquareWebhookEvent(input({
      providerEventId: "event-organization-teardown-fixture",
      providerApplicationId: "app-inbox-teardown",
      providerMerchantId: "merchant-inbox-teardown",
      providerLocationId: "provider-location-inbox-teardown",
    }));

    await deleteOrganization(organization.id);

    expect((await db.select({ id: organizations.id }).from(organizations)
      .where(eq(organizations.id, organization.id)))[0]).toBeUndefined();
    expect((await db.select({ id: locations.id }).from(locations)
      .where(eq(locations.id, location.id)))[0]).toBeUndefined();
    expect((await db.select({ id: webhookEvents.id }).from(webhookEvents)
      .where(eq(webhookEvents.id, ingested.event.id)))[0]).toBeUndefined();
  });

  it("survives a crash after ingestion and fences an expired claim from stale completion", async () => {
    const ingested = await ingestSquareWebhookEvent(input({
      providerEventId: "event-claim-expiry-fixture",
    }));
    expect(ingested.event.status).toBe("pending");
    expect(ingested.event.attemptCount).toBe(0);

    expect(await claimWebhookEvent({
      organizationId: organizationBId,
      eventId: ingested.event.id,
      leaseOwner: "wrong-tenant-worker",
      leaseDurationMs: 60_000,
      now: new Date("2026-08-03T12:02:00.000Z"),
    })).toBeUndefined();

    const firstClaim = await claimWebhookEvent({
      organizationId: organizationAId,
      eventId: ingested.event.id,
      leaseOwner: "worker-a",
      leaseDurationMs: 60_000,
      now: new Date("2026-08-03T12:02:00.000Z"),
    });
    expect(firstClaim?.status).toBe("processing");
    expect(firstClaim?.attemptCount).toBe(1);
    expect(await claimWebhookEvent({
      organizationId: organizationAId,
      eventId: ingested.event.id,
      leaseOwner: "worker-b",
      leaseDurationMs: 60_000,
      now: new Date("2026-08-03T12:02:30.000Z"),
    })).toBeUndefined();

    const reclaimed = await claimWebhookEvent({
      organizationId: organizationAId,
      eventId: ingested.event.id,
      leaseOwner: "worker-b",
      leaseDurationMs: 60_000,
      now: new Date("2026-08-03T12:03:01.000Z"),
    });
    expect(reclaimed?.attemptCount).toBe(2);
    expect(reclaimed?.leaseToken).not.toBe(firstClaim?.leaseToken);

    expect(await completeWebhookEvent({
      organizationId: organizationAId,
      eventId: ingested.event.id,
      leaseToken: firstClaim?.leaseToken ?? "00000000-0000-0000-0000-000000000000",
      outcome: "processed",
      now: new Date("2026-08-03T12:03:02.000Z"),
    })).toBeUndefined();
    const completed = await completeWebhookEvent({
      organizationId: organizationAId,
      eventId: ingested.event.id,
      leaseToken: reclaimed?.leaseToken ?? "00000000-0000-0000-0000-000000000000",
      outcome: "processed",
      now: new Date("2026-08-03T12:03:03.000Z"),
    });
    expect(completed).toMatchObject({ status: "processed", attemptCount: 2 });
    expect(completed?.completedAt).not.toBeNull();
  });

  it("atomically exhausts an expired final-attempt claim", async () => {
    const ingested = await ingestSquareWebhookEvent(input({
      providerEventId: "event-final-claim-expiry-fixture",
    }));
    await db.update(webhookEvents).set({ attemptCount: 19 }).where(eq(
      webhookEvents.id,
      ingested.event.id,
    ));
    const finalClaim = await claimWebhookEvent({
      organizationId: organizationAId,
      eventId: ingested.event.id,
      leaseOwner: "final-attempt-worker",
      leaseDurationMs: 60_000,
      now: new Date("2026-08-03T12:20:00.000Z"),
    });
    expect(finalClaim).toMatchObject({ status: "processing", attemptCount: 20 });

    expect(await claimWebhookEvent({
      organizationId: organizationAId,
      eventId: ingested.event.id,
      leaseOwner: "too-early-worker",
      leaseDurationMs: 60_000,
      now: new Date("2026-08-03T12:20:30.000Z"),
    })).toBeUndefined();
    expect(await claimWebhookEvent({
      organizationId: organizationBId,
      eventId: ingested.event.id,
      leaseOwner: "wrong-tenant-exhaustion-worker",
      leaseDurationMs: 60_000,
      now: new Date("2026-08-03T12:21:01.000Z"),
    })).toBeUndefined();
    expect((await getWebhookEventForOrganization(organizationAId, ingested.event.id))?.status)
      .toBe("processing");
    expect(await claimWebhookEvent({
      organizationId: organizationAId,
      eventId: ingested.event.id,
      leaseOwner: "exhaustion-worker",
      leaseDurationMs: 60_000,
      now: new Date("2026-08-03T12:21:01.000Z"),
    })).toBeUndefined();

    const exhausted = await getWebhookEventForOrganization(organizationAId, ingested.event.id);
    expect(exhausted).toMatchObject({
      status: "failed",
      attemptCount: 20,
      errorClassification: "processing",
      errorCode: "ATTEMPTS_EXHAUSTED",
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
    });
    expect(exhausted?.completedAt).not.toBeNull();
    expect(await completeWebhookEvent({
      organizationId: organizationAId,
      eventId: ingested.event.id,
      leaseToken: finalClaim?.leaseToken ?? "00000000-0000-0000-0000-000000000000",
      outcome: "processed",
      now: new Date("2026-08-03T12:21:02.000Z"),
    })).toBeUndefined();
  });

  it("terminalizes rather than scheduling a retry at the attempt ceiling", async () => {
    const ingested = await ingestSquareWebhookEvent(input({
      providerEventId: "event-final-retry-fixture",
    }));
    await db.update(webhookEvents).set({ attemptCount: 19 }).where(eq(
      webhookEvents.id,
      ingested.event.id,
    ));
    const finalClaim = await claimWebhookEvent({
      organizationId: organizationAId,
      eventId: ingested.event.id,
      leaseOwner: "final-retry-worker",
      leaseDurationMs: 60_000,
      now: new Date("2026-08-03T12:30:00.000Z"),
    });
    const result = await scheduleWebhookEventRetry({
      organizationId: organizationAId,
      eventId: ingested.event.id,
      leaseToken: finalClaim?.leaseToken ?? "00000000-0000-0000-0000-000000000000",
      nextAttemptAt: new Date("2026-08-03T12:35:00.000Z"),
      errorClassification: "processing",
      errorCode: "PROVIDER_TEMPORARY_ERROR",
      now: new Date("2026-08-03T12:30:01.000Z"),
    });

    expect(result).toMatchObject({
      status: "failed",
      attemptCount: 20,
      nextAttemptAt: null,
      errorCode: "ATTEMPTS_EXHAUSTED",
    });
    expect(result?.completedAt).not.toBeNull();
    expect(await claimWebhookEvent({
      organizationId: organizationAId,
      eventId: ingested.event.id,
      leaseOwner: "never-claim-final-retry",
      leaseDurationMs: 60_000,
      now: new Date("2026-08-03T12:35:01.000Z"),
    })).toBeUndefined();
  });

  it("durably marks an unsupported event ignored and retains out-of-order versions as evidence", async () => {
    const ignored = await ingestSquareWebhookEvent(input({
      providerEventId: "event-ignored-fixture",
      eventType: "customer.updated",
      providerObjectType: "customer",
      providerObjectId: "customer-inbox-fixture",
      providerPaymentId: null,
      providerObjectVersion: null,
      providerObjectUpdatedAt: null,
      ignored: true,
    }));
    expect(ignored.event).toMatchObject({
      status: "ignored",
      errorClassification: "processing",
      errorCode: "EVENT_TYPE_NOT_SUPPORTED",
    });
    expect(ignored.event.completedAt).not.toBeNull();

    const newer = await ingestSquareWebhookEvent(input({
      providerEventId: "event-out-of-order-newer",
      providerObjectVersion: 7,
      providerObjectUpdatedAt: "2026-08-03T12:10:00.000Z",
    }));
    const stale = await ingestSquareWebhookEvent(input({
      providerEventId: "event-out-of-order-stale",
      providerObjectVersion: 6,
      providerObjectUpdatedAt: "2026-08-03T12:09:00.000Z",
      now: new Date("2026-08-03T12:11:00.000Z"),
    }));
    expect(newer.event.providerObjectVersion).toBe(7);
    expect(stale.event.providerObjectVersion).toBe(6);
    expect(newer.event.status).toBe("pending");
    expect(stale.event.status).toBe("pending");
  });

  it("keeps tenant-scoped visibility fail closed", async () => {
    const ingested = await ingestSquareWebhookEvent(input({
      providerEventId: "event-visibility-fixture",
    }));
    expect(await getWebhookEventForOrganization(organizationBId, ingested.event.id)).toBeUndefined();
    expect((await getWebhookEventForOrganization(organizationAId, ingested.event.id))?.id)
      .toBe(ingested.event.id);
  });
});
