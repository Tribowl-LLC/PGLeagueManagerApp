import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { bowlers, organizations, users } from "@shared/schema";
import { deleteOrganization } from "../../server/storage/organizations";
import { getTestDb } from "../setup/test-db";
import {
  TEST_ADMIN_EMAIL,
  TEST_ADMIN_PASSWORD,
  apiDelete,
  login,
} from "../helpers";

const db = getTestDb();
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const organizationIds: number[] = [];

async function createBowler(label: string): Promise<{ organizationId: number; bowlerId: number }> {
  const [organization] = await db.insert(organizations).values({
    name: `Bowler deletion route ${label}`,
    slug: `bowler-deletion-route-${label.toLowerCase()}-${suffix}`,
  }).returning({ id: organizations.id });
  if (!organization) throw new Error("route test organization was not created");
  organizationIds.push(organization.id);

  const [bowler] = await db.insert(bowlers).values({
    name: `Bowler deletion route ${label}`,
    email: `bowler-deletion-route-${label.toLowerCase()}-${suffix}@example.test`,
    organizationId: organization.id,
  }).returning({ id: bowlers.id });
  if (!bowler) throw new Error("route test bowler was not created");
  return { organizationId: organization.id, bowlerId: bowler.id };
}

afterAll(async () => {
  for (const organizationId of organizationIds.splice(0)) {
    await deleteOrganization(organizationId).catch(() => undefined);
  }
});

describe("DELETE /api/bowlers/:id", () => {
  it("returns a deliberate 400 for malformed ids", async () => {
    const session = await login(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD);
    const response = await apiDelete("/api/bowlers/not-an-id", session);
    expect(response.status).toBe(400);
    expect(response.data.success).toBe(false);
    expect(response.data.error?.code).toBe("INVALID_ID");
  });

  it("returns a typed 409 blocker and leaves a linked-login bowler intact", async () => {
    const fixture = await createBowler("blocked");
    await db.insert(users).values({
      email: `bowler-deletion-route-linked-${suffix}@example.test`,
      password: "deterministic-test-password-hash",
      name: "Linked route test user",
      role: "user",
      organizationId: fixture.organizationId,
      bowlerId: fixture.bowlerId,
    });
    const session = await login(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD);
    const response = await apiDelete(`/api/bowlers/${fixture.bowlerId}`, session);
    expect(response.status).toBe(409);
    expect(response.data.success).toBe(false);
    expect(response.data.error?.code).toBe("BOWLER_DELETION_BLOCKED");
    const errorWithDetails = response.data.error as { details?: unknown } | undefined;
    expect(errorWithDetails?.details).toMatchObject({ blockers: [{ code: "LINKED_LOGIN" }] });
    expect((await db.select({ id: bowlers.id }).from(bowlers).where(eq(bowlers.id, fixture.bowlerId)))[0]?.id)
      .toBe(fixture.bowlerId);
  });

  it("deletes an unused bowler and returns the normal success envelope", async () => {
    const fixture = await createBowler("unused");
    const session = await login(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD);
    const response = await apiDelete(`/api/bowlers/${fixture.bowlerId}`, session);
    expect(response.status).toBe(200);
    expect(response.data.success).toBe(true);
    expect(response.data.data).toBeNull();
    expect((await db.select({ id: bowlers.id }).from(bowlers).where(eq(bowlers.id, fixture.bowlerId)))[0]).toBeUndefined();
  });
});
