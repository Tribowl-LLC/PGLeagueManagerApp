/**
 * Database-level integrity coverage for the account-to-bowler identity
 * service. The race case uses two independent transactions against the same
 * target row; only one may commit a claim and one event.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { getTestDb } from "../setup/test-db";
import {
  bowlers,
  identityLinkEvents,
  users,
} from "@shared/schema";
import { hashPassword } from "../../server/lib/password";
import {
  IdentityLinkError,
  linkUserToBowler,
} from "../../server/services/identity-link";
import { getBaselineOrgAId, getBaselineOrgIds } from "../helpers";

const db = getTestDb();
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const password = await hashPassword("identity-link-test-password");
let organizationId = 0;
const userIds: number[] = [];
const bowlerIds: number[] = [];

async function createUser(
  name: string,
  role: "user" | "org_admin" = "user",
  email?: string,
) {
  const [user] = await db
    .insert(users)
    .values({
      name: `${name} ${suffix}`,
      email: email ?? `${name.toLowerCase()}-${suffix}@example.com`,
      password,
      role,
      organizationId,
    })
    .returning();
  if (!user) throw new Error("identity-link user fixture was not created");
  userIds.push(user.id);
  return user;
}

async function createBowler(name: string, org = organizationId, email?: string) {
  const [bowler] = await db
    .insert(bowlers)
    .values({
      name: `${name} ${suffix}`,
      email: email ?? `${name.toLowerCase()}-${suffix}@example.com`,
      organizationId: org,
    })
    .returning();
  if (!bowler) throw new Error("identity-link bowler fixture was not created");
  bowlerIds.push(bowler.id);
  return bowler;
}

beforeAll(async () => {
  organizationId = await getBaselineOrgAId();
});

afterAll(async () => {
  if (userIds.length > 0) {
    await db.delete(identityLinkEvents).where(
      orIdentityEventUser(userIds),
    );
  }
  if (bowlerIds.length > 0) {
    await db.delete(identityLinkEvents).where(
      orIdentityEventBowler(bowlerIds),
    );
  }
  if (userIds.length > 0) {
    await db.delete(users).where(inArray(users.id, userIds));
  }
  if (bowlerIds.length > 0) {
    await db.delete(bowlers).where(inArray(bowlers.id, bowlerIds));
  }
});

function orIdentityEventUser(ids: number[]) {
  const firstId = ids[0];
  if (firstId === undefined) throw new Error("identity event user IDs are required");
  return ids.length === 1 ? eq(identityLinkEvents.userId, firstId) : inArray(identityLinkEvents.userId, ids);
}

function orIdentityEventBowler(ids: number[]) {
  const firstId = ids[0];
  if (firstId === undefined) throw new Error("identity event bowler IDs are required");
  return ids.length === 1 ? eq(identityLinkEvents.bowlerId, firstId) : inArray(identityLinkEvents.bowlerId, ids);
}

describe("identity-link service", () => {
  it("serializes a double claim so exactly one user and event win", async () => {
    const first = await createUser("Double Claim One");
    const second = await createUser("Double Claim Two");
    const bowler = await createBowler("Double Claim Target");

    const results = await Promise.allSettled([
      linkUserToBowler({
        organizationId,
        userId: first.id,
        bowlerId: bowler.id,
        source: "test-double-claim",
      }),
      linkUserToBowler({
        organizationId,
        userId: second.id,
        bowlerId: bowler.id,
        source: "test-double-claim",
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(failures).toHaveLength(1);
    expect(failures[0]?.reason).toBeInstanceOf(IdentityLinkError);
    expect((failures[0]?.reason as IdentityLinkError).code).toBe("BOWLER_TAKEN");

    const claims = await db.select({ id: users.id }).from(users).where(eq(users.bowlerId, bowler.id));
    expect(claims).toHaveLength(1);
    const events = await db
      .select()
      .from(identityLinkEvents)
      .where(eq(identityLinkEvents.bowlerId, bowler.id));
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("link");
  });

  it("rejects elevated accounts before changing the user or audit stream", async () => {
    const admin = await createUser("Elevated Account", "org_admin");
    const bowler = await createBowler("Elevated Target");

    await expect(linkUserToBowler({
      organizationId,
      userId: admin.id,
      bowlerId: bowler.id,
      source: "test-elevated",
    })).rejects.toMatchObject({ code: "ELEVATED_ROLE_DENIED" });

    const [unchanged] = await db.select({ bowlerId: users.bowlerId }).from(users).where(eq(users.id, admin.id));
    expect(unchanged?.bowlerId).toBeNull();
    const events = await db.select().from(identityLinkEvents).where(eq(identityLinkEvents.userId, admin.id));
    expect(events).toHaveLength(0);
  });

  it("rejects a cross-organization target", async () => {
    const user = await createUser("Cross Org User");
    const { orgBId } = await getBaselineOrgIds();
    const crossOrgBowler = await createBowler("Cross Org Target", orgBId);

    await expect(linkUserToBowler({
      organizationId,
      userId: user.id,
      bowlerId: crossOrgBowler.id,
      source: "test-cross-org",
    })).rejects.toMatchObject({ code: "CROSS_ORG_DENIED" });

    const [unchanged] = await db.select({ bowlerId: users.bowlerId }).from(users).where(eq(users.id, user.id));
    expect(unchanged?.bowlerId).toBeNull();
    const events = await db.select().from(identityLinkEvents).where(eq(identityLinkEvents.userId, user.id));
    expect(events).toHaveLength(0);
  });

  it("rechecks self-service email ownership while both identity rows are locked", async () => {
    const user = await createUser("Email Proof User");
    const bowler = await createBowler("Email Proof Target", organizationId, user.email);

    // Simulate the bowler email changing after a route-level compatibility
    // read but before the transactional claim begins.
    await db.update(bowlers)
      .set({ email: `changed-${suffix}@example.com` })
      .where(eq(bowlers.id, bowler.id));

    await expect(linkUserToBowler({
      organizationId,
      userId: user.id,
      bowlerId: bowler.id,
      source: "test-email-proof",
      requireEmailMatch: true,
    })).rejects.toMatchObject({ code: "EMAIL_MISMATCH" });

    const [unchanged] = await db.select({ bowlerId: users.bowlerId })
      .from(users).where(eq(users.id, user.id));
    expect(unchanged?.bowlerId).toBeNull();
    const events = await db.select().from(identityLinkEvents)
      .where(eq(identityLinkEvents.subjectUserId, user.id));
    expect(events).toHaveLength(0);
  });

  it("rejects ambiguous shared-email claims, while allowing an explicit admin override", async () => {
    const sharedEmail = `shared-${suffix}@example.com`;
    const adminAssignedUser = await createUser("Shared Email Existing Owner");
    const pendingUser = await createUser("Shared Email Pending User", "user", sharedEmail);
    const claimedProfile = await createBowler("Shared Email Claimed Profile", organizationId, sharedEmail);
    const pendingProfile = await createBowler("Shared Email Pending Profile", organizationId, sharedEmail);

    // An administrator has already resolved the first duplicate to an
    // account with a different email. The second profile must not become
    // self-claimable merely because pendingUser owns the shared address.
    await linkUserToBowler({
      organizationId,
      userId: adminAssignedUser.id,
      bowlerId: claimedProfile.id,
      source: "test-admin-duplicate-resolution",
      requireEmailMatch: false,
    });

    await expect(linkUserToBowler({
      organizationId,
      userId: pendingUser.id,
      bowlerId: pendingProfile.id,
      source: "test-ambiguous-shared-email",
      requireEmailMatch: true,
    })).rejects.toMatchObject({ code: "EMAIL_MISMATCH" });

    const [stillPending] = await db
      .select({ bowlerId: users.bowlerId })
      .from(users)
      .where(eq(users.id, pendingUser.id));
    expect(stillPending?.bowlerId).toBeNull();

    // The same target is linkable when an administrator explicitly chooses
    // it, which is the approved pending/admin-resolution path.
    const override = await linkUserToBowler({
      organizationId,
      userId: pendingUser.id,
      bowlerId: pendingProfile.id,
      source: "test-admin-duplicate-resolution",
      requireEmailMatch: false,
      eventType: "admin_assignment",
    });
    expect(override.user.bowlerId).toBe(pendingProfile.id);
  });

  it("rolls back the user update when the append-only event insert fails", async () => {
    const user = await createUser("Atomicity User");
    const bowler = await createBowler("Atomicity Target");

    // A deliberately invalid actor FK makes the event insert fail after the
    // users update. The service's transaction must roll that update back.
    await expect(linkUserToBowler({
      organizationId,
      userId: user.id,
      bowlerId: bowler.id,
      actorUserId: 2_147_483_647,
      source: "test-atomicity",
    })).rejects.toThrow();

    const [unchanged] = await db.select({ bowlerId: users.bowlerId }).from(users).where(eq(users.id, user.id));
    expect(unchanged?.bowlerId).toBeNull();
    const events = await db.select().from(identityLinkEvents).where(eq(identityLinkEvents.userId, user.id));
    expect(events).toHaveLength(0);
  });

  it.each([null, "", "   "])(
    "fills a blank bowler email and phone from the user's trimmed contact values (blank email: %s)",
    async (blankEmail: string | null) => {
      const label = blankEmail === null ? "null" : blankEmail === "" ? "empty" : "blank";
      const user = await createUser("Contact Fill User", "user", `contact-fill-${label}-${suffix}@example.com`);
      const userPhone = "+1 (555) 010-2345";
      // The service trims the user source before filling a blank contact.
      await db.update(users).set({ phone: `  ${userPhone}  ` }).where(eq(users.id, user.id));

      const bowler = await createBowler("Contact Fill Bowler", organizationId, `contact-fill-bowler-${label}-${suffix}@example.com`);
      await db.update(bowlers).set({ email: blankEmail, phone: blankEmail }).where(eq(bowlers.id, bowler.id));

      const result = await linkUserToBowler({
        organizationId,
        userId: user.id,
        bowlerId: bowler.id,
        source: "test-contact-fill",
      });

      const [filled] = await db.select().from(bowlers).where(eq(bowlers.id, bowler.id));
      expect(filled.email).toBe(`contact-fill-${label}-${suffix}@example.com`);
      expect(filled.phone).toBe(userPhone);
      expect(result.bowler).not.toBeNull();
      expect(result.bowler?.email).toBe(filled.email);
      expect(result.bowler?.phone).toBe(filled.phone);
      const [linked] = await db.select({ bowlerId: users.bowlerId }).from(users).where(eq(users.id, user.id));
      expect(linked.bowlerId).toBe(bowler.id);
    },
  );

  it("preserves the bowler's existing email, phone, and name when the user has different contact values", async () => {
    const user = await createUser("Contact Preserve User", "user", `preserve-user-${suffix}@example.com`);
    await db.update(users).set({ phone: "+1 (555) 010-6666" }).where(eq(users.id, user.id));

    const bowlerEmail = `preserve-bowler-${suffix}@example.com`;
    const bowlerPhone = "+1 (555) 010-7777";
    const bowler = await createBowler("Contact Preserve Bowler", organizationId, bowlerEmail);
    await db.update(bowlers).set({ phone: bowlerPhone }).where(eq(bowlers.id, bowler.id));

    await linkUserToBowler({
      organizationId,
      userId: user.id,
      bowlerId: bowler.id,
      source: "test-contact-preserve",
    });

    const [preserved] = await db.select().from(bowlers).where(eq(bowlers.id, bowler.id));
    expect(preserved.email).toBe(bowlerEmail);
    expect(preserved.phone).toBe(bowlerPhone);
    expect(preserved.name).toBe(`Contact Preserve Bowler ${suffix}`);
    const [linked] = await db.select({ bowlerId: users.bowlerId }).from(users).where(eq(users.id, user.id));
    expect(linked.bowlerId).toBe(bowler.id);
  });

  it.each([null, "", "   "])(
    "leaves a blank bowler phone untouched when the user phone is missing or blank (user phone: %s)",
    async (blankPhone: string | null) => {
      const label = blankPhone === null ? "null" : blankPhone === "" ? "empty" : "blank";
      const user = await createUser("No Phone User", "user", `no-phone-${label}-${suffix}@example.com`);
      if (blankPhone !== null) {
        await db.update(users).set({ phone: blankPhone }).where(eq(users.id, user.id));
      }

      const bowler = await createBowler("No Phone Bowler", organizationId, `no-phone-bowler-${label}-${suffix}@example.com`);
      await db.update(bowlers).set({ email: "", phone: blankPhone }).where(eq(bowlers.id, bowler.id));

      await linkUserToBowler({
        organizationId,
        userId: user.id,
        bowlerId: bowler.id,
        source: "test-no-source-phone",
      });

      const [unchanged] = await db.select().from(bowlers).where(eq(bowlers.id, bowler.id));
      expect(unchanged.phone).toBe(blankPhone);
      expect(unchanged.email).toBe(`no-phone-${label}-${suffix}@example.com`);
    },
  );

  it("rolls back contact fill, the link, and the event when the outer transaction fails", async () => {
    const user = await createUser("Rollback Fill User", "user", `rollback-fill-${suffix}@example.com`);
    await db.update(users).set({ phone: "+1 (555) 010-9999" }).where(eq(users.id, user.id));

    const bowler = await createBowler("Rollback Fill Bowler", organizationId, `rollback-fill-bowler-${suffix}@example.com`);
    await db.update(bowlers).set({ email: "" }).where(eq(bowlers.id, bowler.id));

    await expect(
      db.transaction(async (tx) => {
        await linkUserToBowler(
          {
            organizationId,
            userId: user.id,
            bowlerId: bowler.id,
            source: "test-contact-rollback",
          },
          tx,
        );
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");

    const [userRow] = await db.select().from(users).where(eq(users.id, user.id));
    expect(userRow.bowlerId).toBeNull();
    const [bowlerRow] = await db.select().from(bowlers).where(eq(bowlers.id, bowler.id));
    expect(bowlerRow.email).toBe("");
    expect(bowlerRow.phone).toBeNull();
    const userEvents = await db.select().from(identityLinkEvents).where(eq(identityLinkEvents.userId, user.id));
    expect(userEvents).toHaveLength(0);
    const bowlerEvents = await db.select().from(identityLinkEvents).where(eq(identityLinkEvents.bowlerId, bowler.id));
    expect(bowlerEvents).toHaveLength(0);
  });
});
