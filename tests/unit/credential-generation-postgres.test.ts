/**
 * PostgreSQL coverage for the database-owned credential generation.
 *
 * The generation is part of Passport's session payload, so these assertions
 * deliberately exercise the trigger against a real database. Application
 * tests can prove that a route calls the right helper; only PostgreSQL can
 * prove that a direct password/email UPDATE cannot skip the invalidation
 * boundary or assign a forged generation.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import passport from "passport";
import { getTestDb } from "../setup/test-db";
import {
  accountActionRequests,
  emailChangeRequests,
  users,
  type User,
} from "@shared/schema";
import { hashAccountActionToken, lockAccountCredential } from "../../server/storage/account-action-requests";
import { setupAuth } from "../../server/auth";
import { applyConfirmEmailChangeTxn } from "../../server/services/account-lifecycle";
import { getBaselineOrgAId } from "../helpers";

const db = getTestDb();
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const fixtureUserIds: number[] = [];
let organizationId = 0;

function futureIso(): string {
  return new Date(Date.now() + 60 * 60 * 1000).toISOString();
}

async function createFixtureUser(label: string): Promise<User> {
  const [user] = await db.insert(users).values({
    name: `${label} ${suffix}`,
    email: `${label.toLowerCase().replaceAll(" ", "-")}-${suffix}@example.com`,
    password: "password-hash-before-rotation",
    role: "user",
    organizationId,
  }).returning();
  if (!user) throw new Error("credential-generation fixture user was not created");
  fixtureUserIds.push(user.id);
  return user;
}

async function createPendingAction(userId: number, action: "account_invite" | "password_reset") {
  const token = `${action}-${userId}-${suffix}-${Math.random()}`;
  const [request] = await db.insert(accountActionRequests).values({
    userId,
    organizationId,
    action,
    tokenHash: hashAccountActionToken(token),
    expiresAt: futureIso(),
    deliveryStatus: "not_attempted",
  }).returning();
  if (!request) throw new Error("credential-generation account action was not created");
  return request;
}

async function createPendingEmailChange(userId: number) {
  const [request] = await db.insert(emailChangeRequests).values({
    userId,
    newEmail: `next-${userId}-${suffix}@example.com`,
    tokenHash: hashAccountActionToken(`email-${userId}-${suffix}-${Math.random()}`),
    expiresAt: futureIso(),
  }).returning();
  if (!request) throw new Error("credential-generation email change was not created");
  return request;
}

type PassportSerializer = (
  user: unknown,
  done: (error: unknown, serialized?: unknown) => void,
) => void;

let serializeUser: PassportSerializer;

beforeAll(async () => {
  organizationId = await getBaselineOrgAId();

  // Use the production serializer with the worker's real database. The fake
  // app only absorbs middleware registration; no HTTP server is needed for
  // the race below.
  await setupAuth({ set: () => undefined, use: () => undefined } as never);
  const serializers = (passport as typeof passport & {
    _serializers: PassportSerializer[];
  })._serializers;
  const latest = serializers.at(-1);
  if (!latest) throw new Error("setupAuth did not register a Passport serializer");
  serializeUser = latest;
});

afterAll(async () => {
  if (fixtureUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, fixtureUserIds));
    fixtureUserIds.length = 0;
  }
});

describe("users credential-generation trigger", () => {
  it("increments on password and email changes and revokes every pending credential action", async () => {
    const user = await createFixtureUser("Generation Rotation");
    const reset = await createPendingAction(user.id, "password_reset");
    const invitation = await createPendingAction(user.id, "account_invite");
    const emailChange = await createPendingEmailChange(user.id);

    const [afterPassword] = await db.update(users)
      .set({ password: "password-hash-after-password-rotation" })
      .where(eq(users.id, user.id))
      .returning({ credentialGeneration: users.credentialGeneration });
    expect(afterPassword?.credentialGeneration).toBe(user.credentialGeneration + 1);

    const actionsAfterPassword = await db.select({
      id: accountActionRequests.id,
      status: accountActionRequests.status,
      revokedAt: accountActionRequests.revokedAt,
    }).from(accountActionRequests).where(eq(accountActionRequests.userId, user.id));
    expect(actionsAfterPassword).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: reset.id, status: "revoked", revokedAt: expect.anything() }),
      expect.objectContaining({ id: invitation.id, status: "revoked", revokedAt: expect.anything() }),
    ]));
    const [emailAfterPassword] = await db.select({ consumedAt: emailChangeRequests.consumedAt })
      .from(emailChangeRequests).where(eq(emailChangeRequests.id, emailChange.id));
    expect(emailAfterPassword?.consumedAt).not.toBeNull();

    // A later email rotation must advance the same generation boundary. Add
    // fresh pending rows first so this assertion also proves the trigger is
    // responsible for invalidating requests created after the first change.
    const secondReset = await createPendingAction(user.id, "password_reset");
    const secondEmailChange = await createPendingEmailChange(user.id);
    const [afterEmail] = await db.update(users)
      .set({ email: `rotated-${user.id}-${suffix}@example.com` })
      .where(eq(users.id, user.id))
      .returning({ credentialGeneration: users.credentialGeneration });
    expect(afterEmail?.credentialGeneration).toBe(user.credentialGeneration + 2);

    const [secondActionAfterEmail] = await db.select({
      status: accountActionRequests.status,
      revokedAt: accountActionRequests.revokedAt,
    }).from(accountActionRequests).where(eq(accountActionRequests.id, secondReset.id));
    expect(secondActionAfterEmail?.status).toBe("revoked");
    expect(secondActionAfterEmail?.revokedAt).not.toBeNull();
    const [secondEmailAfterEmail] = await db.select({ consumedAt: emailChangeRequests.consumedAt })
      .from(emailChangeRequests).where(eq(emailChangeRequests.id, secondEmailChange.id));
    expect(secondEmailAfterEmail?.consumedAt).not.toBeNull();
  });

  it("does not rotate or revoke when the password value is unchanged", async () => {
    const user = await createFixtureUser("Generation Same Password");
    const action = await createPendingAction(user.id, "password_reset");
    const emailChange = await createPendingEmailChange(user.id);

    const [updated] = await db.update(users)
      // Including password in the UPDATE is intentional: the trigger must
      // compare values, rather than treating every password-column write as
      // a credential mutation.
      .set({ password: user.password })
      .where(eq(users.id, user.id))
      .returning({ credentialGeneration: users.credentialGeneration });
    expect(updated?.credentialGeneration).toBe(user.credentialGeneration);

    const [actionAfter] = await db.select({
      status: accountActionRequests.status,
      revokedAt: accountActionRequests.revokedAt,
    }).from(accountActionRequests).where(eq(accountActionRequests.id, action.id));
    expect(actionAfter).toEqual({ status: "pending", revokedAt: null });
    const [emailAfter] = await db.select({ consumedAt: emailChangeRequests.consumedAt })
      .from(emailChangeRequests).where(eq(emailChangeRequests.id, emailChange.id));
    expect(emailAfter?.consumedAt).toBeNull();
  });

  it("rejects a caller that tries to assign credential generation directly", async () => {
    const user = await createFixtureUser("Generation Tamper");

    await expect(db.update(users)
      .set({ credentialGeneration: user.credentialGeneration + 1 })
      .where(eq(users.id, user.id)))
      // Drizzle exposes the node-postgres SQLSTATE on `cause` for query
      // failures; keep the assertion on the database error rather than the
      // wrapper's implementation details.
      .rejects.toMatchObject({ cause: { code: "23514" } });

    const [unchanged] = await db.select({
      password: users.password,
      credentialGeneration: users.credentialGeneration,
    }).from(users).where(eq(users.id, user.id));
    expect(unchanged).toEqual({
      password: user.password,
      credentialGeneration: user.credentialGeneration,
    });
  });

  it("rejects a stale login snapshot when a concurrent rotation commits first", async () => {
    const user = await createFixtureUser("Generation Login Race");
    // This is the snapshot returned by the password verification query before
    // the concurrent reset commits. It is deliberately retained unchanged.
    const [staleSnapshot] = await db.select().from(users).where(eq(users.id, user.id));
    if (!staleSnapshot) throw new Error("credential-generation stale snapshot was not loaded");

    let markRotationReady!: () => void;
    const rotationReady = new Promise<void>(resolve => { markRotationReady = resolve; });
    let releaseRotation!: () => void;
    const holdRotation = new Promise<void>(resolve => { releaseRotation = resolve; });

    const rotation = db.transaction(async tx => {
      await lockAccountCredential(tx, user.id);
      await tx.update(users)
        .set({ password: "password-hash-raced-rotation" })
        .where(eq(users.id, user.id));
      // The trigger has run, but the change is still uncommitted. The
      // serializer below must wait for this transaction's account lock.
      markRotationReady();
      await holdRotation;
    });
    await rotationReady;

    const serialized = new Promise<{ error: unknown; value: unknown }>(resolve => {
      serializeUser(staleSnapshot, (error, value) => resolve({ error, value }));
    });
    // Let the rotation commit only after the serializer has been started.
    // Whether it is already waiting on the advisory lock or is about to
    // acquire it, its authoritative read occurs after this commit.
    releaseRotation();
    await rotation;

    const result = await serialized;
    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toBe("Stale user object during serialization");
    expect(result.value).toBeUndefined();

    const [current] = await db.select({
      password: users.password,
      credentialGeneration: users.credentialGeneration,
    }).from(users).where(eq(users.id, user.id));
    expect(current).toEqual({
      password: "password-hash-raced-rotation",
      credentialGeneration: user.credentialGeneration + 1,
    });
  });

  it("keeps email confirmation and a concurrent credential rotation deadlock-free", async () => {
    const user = await createFixtureUser("Generation Lock Ordering");
    const emailChange = await createPendingEmailChange(user.id);

    let markUserLocked!: () => void;
    const userLocked = new Promise<void>(resolve => { markUserLocked = resolve; });
    let allowCredentialUpdate!: () => void;
    const credentialUpdateAllowed = new Promise<void>(resolve => { allowCredentialUpdate = resolve; });

    // Hold the user row before starting confirmation. With the corrected
    // order, confirmation waits on this row before claiming the email row;
    // the credential UPDATE can then run its user -> account-action ->
    // email-change trigger path and commit cleanly.
    const credentialRotation = db.transaction(async tx => {
      await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, user.id))
        .limit(1)
        .for("update");
      markUserLocked();
      await credentialUpdateAllowed;
      await tx
        .update(users)
        .set({ password: "password-hash-lock-order-rotation" })
        .where(eq(users.id, user.id));
    });
    await userLocked;

    // The short scheduling window lets the confirmation transaction reach its
    // first lock request while the user row is held. Under the old
    // email-row-first order this paired with the trigger's user-row-first
    // path and produced a PostgreSQL deadlock; the corrected order makes the
    // confirmation observe the trigger-revoked token after the rotation.
    const confirmation = applyConfirmEmailChangeTxn(emailChange.tokenHash);
    await new Promise<void>(resolve => setTimeout(resolve, 50));
    allowCredentialUpdate();

    const [rotationResult, confirmationResult] = await Promise.all([
      credentialRotation,
      confirmation,
    ]);
    expect(rotationResult).toBeUndefined();
    expect(confirmationResult).toEqual({ kind: "consumed" });
  });
});
