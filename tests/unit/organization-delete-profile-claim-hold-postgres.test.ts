/** Organization teardown must remove resolved profile-claim holds first. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  bowlers,
  identityLinkEvents,
  identitySecurityHolds,
  organizations,
  profileClaimNotifications,
  profileClaimReportTokens,
  users,
} from "@shared/schema";
import { getTestDb } from "../setup/test-db";
import { deleteOrganization } from "../../server/storage/organizations";
import { profileClaimReportTokenHashForEvent } from "../../server/storage/profile-claim-notifications";

const db = getTestDb();
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
let organizationId = 0;

beforeAll(async () => {
  const [organization] = await db.insert(organizations).values({
    name: `Profile claim teardown ${suffix}`,
    slug: `profile-claim-teardown-${suffix}`,
  }).returning({ id: organizations.id });
  if (!organization) throw new Error("profile-claim teardown organization was not created");
  organizationId = organization.id;

  const [user] = await db.insert(users).values({
    name: `Profile claim teardown user ${suffix}`,
    email: `profile-claim-teardown-${suffix}@example.test`,
    password: "deterministic-test-password-hash",
    role: "user",
    organizationId,
  }).returning({ id: users.id });
  const [bowler] = await db.insert(bowlers).values({
    name: `Profile claim teardown bowler ${suffix}`,
    email: `profile-claim-teardown-bowler-${suffix}@example.test`,
    organizationId,
  }).returning({ id: bowlers.id, name: bowlers.name });
  if (!user || !bowler) throw new Error("profile-claim teardown identity fixture was not created");

  const [event] = await db.insert(identityLinkEvents).values({
    organizationId,
    subjectUserId: user.id,
    userId: user.id,
    bowlerId: bowler.id,
    newBowlerId: bowler.id,
    eventType: "link",
    source: "profile-claim-teardown-test",
  }).returning({ id: identityLinkEvents.id });
  if (!event) throw new Error("profile-claim teardown link event was not created");

  const tokenHash = profileClaimReportTokenHashForEvent(event.id);
  const [notification] = await db.insert(profileClaimNotifications).values({
    identityLinkEventId: event.id,
    userId: user.id,
    bowlerId: bowler.id,
    organizationId,
    recipientEmail: "original-roster@example.test",
    recipientSource: "roster",
    recipientName: bowler.name,
    bowlerName: bowler.name,
    reportTokenHash: tokenHash,
    reportTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  }).returning({ id: profileClaimNotifications.id });
  if (!notification) throw new Error("profile-claim teardown notification was not created");
  const [reportToken] = await db.insert(profileClaimReportTokens).values({
    notificationId: notification.id,
    tokenHash,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }).returning({ id: profileClaimReportTokens.id });
  if (!reportToken) throw new Error("profile-claim teardown token was not created");

  await db.insert(identitySecurityHolds).values({
    notificationId: notification.id,
    reportTokenId: reportToken.id,
    userId: user.id,
    bowlerId: bowler.id,
    organizationId,
    status: "resolved",
    reason: "resolved test report",
    resolution: "reviewed",
    resolvedAt: new Date().toISOString(),
  });
});

afterAll(async () => {
  if (organizationId) await deleteOrganization(organizationId).catch(() => undefined);
});

describe("organization teardown profile-claim hold cleanup", () => {
  it("deletes resolved holds before their restrictive parents", async () => {
    await deleteOrganization(organizationId);

    expect(await db.select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, organizationId))).toHaveLength(0);
    expect(await db.select({ id: identitySecurityHolds.id })
      .from(identitySecurityHolds)
      .where(eq(identitySecurityHolds.organizationId, organizationId))).toHaveLength(0);
  });
});
