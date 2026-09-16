/**
 * System-admin API contract for global SendGrid delivery alerts.
 * The fixtures deliberately contain no organization mapping: an event can
 * arrive before an application action exists, and tenant admins must never
 * be able to read or acknowledge this provider-operational evidence.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../server/db";
import { emailDeliveryAlerts } from "@shared/schema";
import type { EmailDeliveryAlertsResponse } from "@shared/email-delivery-alerts";
import {
  apiGet,
  apiPost,
  login,
  TEST_ADMIN_EMAIL,
  TEST_ADMIN_PASSWORD,
  TEST_ORG_A_EMAIL,
  TEST_ORG_PASSWORD,
  type AuthSession,
} from "../helpers";

const runTag = `email-alert-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describe("system-admin email delivery alerts API", () => {
  let sysAdmin: AuthSession;
  let orgAdmin: AuthSession;
  const alertIds: number[] = [];
  let pendingId = 0;
  let acknowledgedId = 0;

  beforeAll(async () => {
    sysAdmin = await login(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD);
    orgAdmin = await login(TEST_ORG_A_EMAIL, TEST_ORG_PASSWORD);
    const now = new Date();
    const rows = await db
      .insert(emailDeliveryAlerts)
      .values([
        {
          providerEventId: `${runTag}-pending`,
          providerMessageId: `${runTag}-message-pending`,
          recipientEmail: `${runTag}-pending@example.test`,
          eventType: "bounce",
          failureType: "blocked",
          reasonCode: "sending_ip_blocklisted",
          bounceClassification: "reputation",
          smtpStatus: "5.7.1",
          sendingIp: "192.0.2.10",
          providerEventAt: new Date(now.getTime() - 2_000).toISOString(),
          receivedAt: new Date(now.getTime() - 1_000).toISOString(),
        },
        {
          providerEventId: `${runTag}-pending-2`,
          providerMessageId: null,
          recipientEmail: `${runTag}-pending-2@example.test`,
          eventType: "dropped",
          failureType: "dropped",
          reasonCode: "provider_dropped",
          bounceClassification: null,
          smtpStatus: null,
          sendingIp: null,
          providerEventAt: new Date(now.getTime() - 4_000).toISOString(),
          receivedAt: new Date(now.getTime() - 3_000).toISOString(),
        },
        {
          providerEventId: `${runTag}-acknowledged`,
          providerMessageId: `${runTag}-message-acknowledged`,
          recipientEmail: `${runTag}-acknowledged@example.test`,
          eventType: "bounce",
          failureType: "bounce",
          reasonCode: "recipient_address_invalid",
          bounceClassification: "invalid_address",
          smtpStatus: "5.1.1",
          sendingIp: "2001:db8::10",
          providerEventAt: new Date(now.getTime() - 6_000).toISOString(),
          receivedAt: new Date(now.getTime() - 5_000).toISOString(),
          acknowledgedAt: new Date(now.getTime() - 500).toISOString(),
          acknowledgedByUserId: sysAdmin.user.id,
        },
      ])
      .returning({ id: emailDeliveryAlerts.id });
    alertIds.push(...rows.map((row) => row.id));
    pendingId = rows[0]?.id ?? 0;
    acknowledgedId = rows[2]?.id ?? 0;
    expect(pendingId).toBeGreaterThan(0);
    expect(acknowledgedId).toBeGreaterThan(0);
  });

  afterAll(async () => {
    if (alertIds.length > 0) {
      await db.delete(emailDeliveryAlerts).where(inArray(emailDeliveryAlerts.id, alertIds));
    }
  });

  it("requires authentication for list and pending count", async () => {
    const list = await apiGet("/api/system-admin/email-delivery-alerts");
    const count = await apiGet("/api/system-admin/email-delivery-alerts/pending-count");
    expect(list.status).toBe(401);
    expect(count.status).toBe(401);
    expect(list.data.data).toBeUndefined();
    expect(count.data.data).toBeUndefined();
  });

  it("denies org admins from list, pending count, and acknowledge", async () => {
    const list = await apiGet("/api/system-admin/email-delivery-alerts", orgAdmin);
    const count = await apiGet("/api/system-admin/email-delivery-alerts/pending-count", orgAdmin);
    const ack = await apiPost(`/api/system-admin/email-delivery-alerts/${pendingId}/acknowledge`, {}, orgAdmin);
    expect(list.status).toBe(403);
    expect(count.status).toBe(403);
    expect(ack.status).toBe(403);
  });

  it("returns pending alerts by default and acknowledged history only when requested", async () => {
    const pending = await apiGet<EmailDeliveryAlertsResponse>(
      "/api/system-admin/email-delivery-alerts",
      sysAdmin,
    );
    expect(pending.status).toBe(200);
    expect(pending.data.success).toBe(true);
    expect(pending.data.data?.alerts.some((row) => row.id === pendingId)).toBe(true);
    expect(pending.data.data?.alerts.some((row) => row.id === acknowledgedId)).toBe(false);
    expect(pending.data.data?.unacknowledgedCount).toEqual(expect.any(Number));
    expect(pending.data.data?.webhookConfigured).toEqual(expect.any(Boolean));
    expect(pending.data.data?.alerts[0]).toEqual(expect.objectContaining({
      id: expect.any(Number),
      recipientEmail: `${runTag}-pending@example.test`,
      providerEventAt: expect.stringMatching(/Z$/),
      receivedAt: expect.stringMatching(/Z$/),
      acknowledgedAt: null,
    }));

    const history = await apiGet<EmailDeliveryAlertsResponse>(
      "/api/system-admin/email-delivery-alerts?acknowledged=true",
      sysAdmin,
    );
    expect(history.status).toBe(200);
    expect(history.data.data?.alerts.some((row) => row.id === acknowledgedId)).toBe(true);
    expect(history.data.data?.alerts.some((row) => row.id === pendingId)).toBe(false);
  });

  it("validates acknowledged filter and requires CSRF for acknowledge", async () => {
    const invalid = await apiGet("/api/system-admin/email-delivery-alerts?acknowledged=maybe", sysAdmin);
    expect(invalid.status).toBe(400);

    const csrfMissing = await fetch(
      `${process.env.TEST_BASE_URL || "http://localhost:5000"}/api/system-admin/email-delivery-alerts/${pendingId}/acknowledge`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: sysAdmin.cookies,
        },
        body: "{}",
      },
    );
    expect(csrfMissing.status).toBe(403);
  });

  it("acknowledges an alert idempotently and updates the pending count", async () => {
    const beforeCount = await apiGet<{ count: number }>(
      "/api/system-admin/email-delivery-alerts/pending-count",
      sysAdmin,
    );
    expect(beforeCount.status).toBe(200);
    const pendingCountBeforeAck = beforeCount.data.data?.count;
    expect(pendingCountBeforeAck).toEqual(expect.any(Number));
    if (typeof pendingCountBeforeAck !== "number") throw new Error("pending count was not returned");

    const first = await apiPost<{ alert: { id: number; acknowledgedAt: string | null }; acknowledged: boolean }>(
      `/api/system-admin/email-delivery-alerts/${pendingId}/acknowledge`,
      {},
      sysAdmin,
    );
    expect(first.status).toBe(200);
    expect(first.data.data?.acknowledged).toBe(true);
    expect(first.data.data?.alert.id).toBe(pendingId);
    const acknowledgedAt = first.data.data?.alert.acknowledgedAt;
    expect(acknowledgedAt).toMatch(/Z$/);

    const second = await apiPost<{ alert: { id: number; acknowledgedAt: string | null }; acknowledged: boolean }>(
      `/api/system-admin/email-delivery-alerts/${pendingId}/acknowledge`,
      {},
      sysAdmin,
    );
    expect(second.status).toBe(200);
    expect(second.data.data?.alert.acknowledgedAt).toBe(acknowledgedAt);

    const count = await apiGet<{ count: number }>(
      "/api/system-admin/email-delivery-alerts/pending-count",
      sysAdmin,
    );
    expect(count.status).toBe(200);
    expect(count.data.data?.count).toBe(pendingCountBeforeAck - 1);
    const pending = await apiGet<EmailDeliveryAlertsResponse>(
      "/api/system-admin/email-delivery-alerts",
      sysAdmin,
    );
    expect(pending.data.data?.alerts.some((row) => row.id === pendingId)).toBe(false);
  });

  it("rejects invalid and missing alert IDs without touching the database", async () => {
    const invalid = await apiPost("/api/system-admin/email-delivery-alerts/nope/acknowledge", {}, sysAdmin);
    const tooLarge = await apiPost(
      "/api/system-admin/email-delivery-alerts/2147483648/acknowledge",
      {},
      sysAdmin,
    );
    const missing = await apiPost(
      "/api/system-admin/email-delivery-alerts/2147483647/acknowledge",
      {},
      sysAdmin,
    );
    expect(invalid.status).toBe(400);
    expect(tooLarge.status).toBe(400);
    expect(missing.status).toBe(404);
  });
});
