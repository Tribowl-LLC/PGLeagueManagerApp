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

async function createUser(name: string, role: "user" | "org_admin" = "user") {
  const [user] = await db
    .insert(users)
    .values({
      name: `${name} ${suffix}`,
      email: `${name.toLowerCase()}-${suffix}@example.com`,
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
});
