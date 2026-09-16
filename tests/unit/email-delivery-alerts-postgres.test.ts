/** PostgreSQL idempotency coverage for SendGrid operational alerts. */
import { afterAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { getTestDb } from "../setup/test-db";
import { emailDeliveryAlerts } from "@shared/schema";
import { ingestEmailDeliveryAlert } from "../../server/storage/email-delivery-alerts";

const db = getTestDb();
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const providerEventIds = [
  `storage-alert-${suffix}`,
  `storage-alert-race-${suffix}`,
] as const;

function input(providerEventId: string) {
  return {
    providerEventId,
    providerMessageId: "storage-message",
    recipientEmail: "storage-recipient@example.test",
    eventType: "bounce" as const,
    failureType: "blocked" as const,
    reasonCode: "sending_ip_blocklisted" as const,
    bounceClassification: "reputation" as const,
    smtpStatus: "5.7.1",
    sendingIp: "192.0.2.10",
    providerEventAt: new Date("2026-09-16T00:00:00.000Z").toISOString(),
  };
}

describe("email delivery alert storage", () => {
  afterAll(async () => {
    await db
      .delete(emailDeliveryAlerts)
      .where(inArray(emailDeliveryAlerts.providerEventId, providerEventIds));
  });

  it("deduplicates a replay without overwriting the original evidence", async () => {
    const original = input(providerEventIds[0]);
    const first = await ingestEmailDeliveryAlert(original);
    expect(first).toMatchObject({ duplicate: false });

    const replay = await ingestEmailDeliveryAlert({
      ...original,
      recipientEmail: "different-recipient@example.test",
      reasonCode: "policy_rejection",
    });
    expect(replay).toMatchObject({ duplicate: true });
    expect(replay.alert?.recipientEmail).toBe(original.recipientEmail);
    expect(replay.alert?.reasonCode).toBe(original.reasonCode);

    const rows = await db
      .select()
      .from(emailDeliveryAlerts)
      .where(eq(emailDeliveryAlerts.providerEventId, providerEventIds[0]));
    expect(rows).toHaveLength(1);
  });

  it("converges concurrent inserts on one provider event row", async () => {
    const event = input(providerEventIds[1]);
    const results = await Promise.all([
      ingestEmailDeliveryAlert(event),
      ingestEmailDeliveryAlert(event),
    ]);
    expect(results.filter((result) => result.duplicate)).toHaveLength(1);
    expect(results.filter((result) => !result.duplicate)).toHaveLength(1);

    const rows = await db
      .select({ id: emailDeliveryAlerts.id })
      .from(emailDeliveryAlerts)
      .where(eq(emailDeliveryAlerts.providerEventId, event.providerEventId));
    expect(rows).toHaveLength(1);
  });
});
