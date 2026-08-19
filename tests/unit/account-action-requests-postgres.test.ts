/**
 * Storage-level coverage for one-time account actions. These tests deliberately
 * use PostgreSQL rather than mocks so the partial pending uniqueness index,
 * transactional status transitions, and concurrent consume race are exercised
 * against the same constraints used in production.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { getTestDb } from "../setup/test-db";
import {
  accountActionRequests,
  users,
} from "@shared/schema";
import {
  consumeAccountActionAndSetPassword,
  getAccountActionByToken,
  hashAccountActionToken,
  issueAccountAction,
  revokeAccountAction,
} from "../../server/storage/account-action-requests";
import { getBaselineOrgAId } from "../helpers";

const db = getTestDb();
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const userIds: number[] = [];
let organizationId = 0;

async function createFixtureUser(label: string, mustChangePassword = true) {
  const [user] = await db
    .insert(users)
    .values({
      name: `${label} ${suffix}`,
      email: `${label.toLowerCase().replaceAll(" ", "-")}-${suffix}@example.com`,
      password: "old-password-hash",
      role: "user",
      organizationId,
      mustChangePassword,
    })
    .returning();
  if (!user) throw new Error("account-action fixture user was not created");
  userIds.push(user.id);
  return user;
}

beforeAll(async () => {
  organizationId = await getBaselineOrgAId();
});

afterAll(async () => {
  if (userIds.length > 0) {
    // Account actions cascade from their user; deleting the fixture users also
    // removes consumed, superseded, expired, and revoked test rows.
    await db.delete(users).where(inArray(users.id, userIds));
  }
});

describe("account action request storage", () => {
  it("supersedes a resend and persists only a SHA-256 token digest", async () => {
    const user = await createFixtureUser("Action Resend");
    const first = await issueAccountAction({
      userId: user.id,
      action: "account_invite",
      organizationId,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    const second = await issueAccountAction({
      userId: user.id,
      action: "account_invite",
      organizationId,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const [firstRow, secondRow] = await Promise.all([
      db
        .select()
        .from(accountActionRequests)
        .where(eq(accountActionRequests.id, first.request.id)),
      db
        .select()
        .from(accountActionRequests)
        .where(eq(accountActionRequests.id, second.request.id)),
    ]);

    expect(firstRow[0]?.status).toBe("superseded");
    expect(secondRow[0]?.status).toBe("pending");
    expect(secondRow[0]?.tokenHash).toBe(hashAccountActionToken(second.token));
    expect(secondRow[0]?.tokenHash).not.toBe(second.token);
    expect(secondRow[0]).not.toHaveProperty("token");
    expect(first.token).not.toBe(second.token);

    const columns = await db.execute<{ column_name: string }>(sql`
      SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'account_action_requests'
         AND column_name ILIKE '%token%'
    `);
    expect(columns.rows.map((row) => row.column_name)).toEqual(["token_hash"]);
  });

  it("allows exactly one concurrent consume and clears forced rotation", async () => {
    const user = await createFixtureUser("Action Concurrent");
    const issued = await issueAccountAction({
      userId: user.id,
      action: "password_reset",
      organizationId,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const results = await Promise.all([
      consumeAccountActionAndSetPassword({
        token: issued.token,
        passwordHash: "new-password-hash-a",
      }),
      consumeAccountActionAndSetPassword({
        token: issued.token,
        passwordHash: "new-password-hash-b",
      }),
    ]);

    expect(results.filter((result) => result !== undefined)).toHaveLength(1);
    expect(results.filter((result) => result === undefined)).toHaveLength(1);

    const [updatedUser] = await db
      .select({ password: users.password, mustChangePassword: users.mustChangePassword })
      .from(users)
      .where(eq(users.id, user.id));
    expect(updatedUser?.password).toMatch(/^new-password-hash-[ab]$/);
    expect(updatedUser?.mustChangePassword).toBe(false);

    const [consumed] = await db
      .select({ status: accountActionRequests.status, consumedAt: accountActionRequests.consumedAt })
      .from(accountActionRequests)
      .where(eq(accountActionRequests.id, issued.request.id));
    expect(consumed?.status).toBe("consumed");
    expect(consumed?.consumedAt).not.toBeNull();
  });

  it("distinguishes lazy expiry and revocation from a usable pending action", async () => {
    const user = await createFixtureUser("Action Lifecycle", false);
    const expiredToken = "expired-action-token";
    const [expired] = await db
      .insert(accountActionRequests)
      .values({
        userId: user.id,
        organizationId,
        action: "account_invite",
        tokenHash: hashAccountActionToken(expiredToken),
        expiresAt: new Date(Date.now() - 60 * 1000).toISOString(),
        status: "pending",
        deliveryStatus: "not_attempted",
      })
      .returning();
    if (!expired) throw new Error("expired account-action fixture was not created");

    const expiredLookup = await getAccountActionByToken(expiredToken);
    expect(expiredLookup?.request.status).toBe("expired");
    expect(expiredLookup?.request.expiredAt).not.toBeNull();
    expect(await consumeAccountActionAndSetPassword({
      token: expiredToken,
      passwordHash: "must-not-be-used",
    })).toBeUndefined();

    const revoked = await issueAccountAction({
      userId: user.id,
      action: "password_reset",
      organizationId,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    const revokedResult = await revokeAccountAction(revoked.request.id);
    expect(revokedResult?.status).toBe("revoked");
    expect(revokedResult?.revokedAt).not.toBeNull();

    const revokedLookup = await getAccountActionByToken(revoked.token);
    expect(revokedLookup?.request.status).toBe("revoked");
    expect(await consumeAccountActionAndSetPassword({
      token: revoked.token,
      passwordHash: "must-not-be-used",
    })).toBeUndefined();
  });
});
