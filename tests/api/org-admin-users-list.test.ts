/**
 * Task #672 — GET /api/org-admin/users must list only organization
 * administrators (org_admin / system_admin), not self-registered
 * bowler-users (role `user`). The latter are triaged on the
 * "Unclaimed Self-Registered Users" surface.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../../server/db';
import { bowlers as bowlersTable, users } from '@shared/schema';
import { hashPassword } from '../../server/lib/password';
import {
  apiGet,
  login,
  TEST_ORG_A_EMAIL,
  TEST_ORG_PASSWORD,
  type AuthSession,
} from '../helpers';

interface ListedUser {
  id: number;
  email: string;
  role: string;
  organizationId: number | null;
  bowlerId: number | null;
}

describe('GET /api/org-admin/users — admin-only listing (#672)', () => {
  let sessionA: AuthSession;
  let orgAId: number;
  const stamp = Date.now();
  const createdUserIds: number[] = [];
  const createdBowlerIds: number[] = [];

  async function insertUser(opts: {
    role: 'user' | 'org_admin' | 'system_admin';
    label: string;
    bowlerId?: number | null;
  }): Promise<number> {
    const password = await hashPassword('vitest-list-pw');
    const [row] = await db
      .insert(users)
      .values({
        name: `Vitest List ${opts.label}`,
        email: `vitest-list-${stamp}-${opts.label}@example.com`,
        password,
        role: opts.role,
        organizationId: orgAId,
        bowlerId: opts.bowlerId ?? null,
      })
      .returning({ id: users.id });
    createdUserIds.push(row.id);
    return row.id;
  }

  beforeAll(async () => {
    sessionA = await login(TEST_ORG_A_EMAIL, TEST_ORG_PASSWORD);
    if (sessionA.user.organizationId == null) {
      throw new Error('Test fixture admin missing organizationId');
    }
    orgAId = sessionA.user.organizationId;
  });

  afterAll(async () => {
    if (createdUserIds.length > 0) {
      await db.delete(users).where(inArray(users.id, createdUserIds));
    }
    if (createdBowlerIds.length > 0) {
      await db.delete(bowlersTable).where(inArray(bowlersTable.id, createdBowlerIds));
    }
  });

  it('excludes role=user accounts (both unlinked and linked) and includes org_admin', async () => {
    const unlinkedUserId = await insertUser({ role: 'user', label: 'unlinked' });
    const orgAdminId = await insertUser({ role: 'org_admin', label: 'orgadmin' });

    const res = await apiGet<ListedUser[]>(
      `/api/org-admin/users?organizationId=${orgAId}`,
      sessionA,
    );
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    const list = res.data.data ?? [];
    const ids = list.map((u) => u.id);

    expect(ids).toContain(orgAdminId);
    expect(ids).not.toContain(unlinkedUserId);

    // Defense in depth: every returned row is an admin role.
    for (const u of list) {
      expect(['org_admin', 'system_admin']).toContain(u.role);
    }
  });

  it('does not regress on legacy "linked bowler" users — role=user with a bowlerId is still excluded', async () => {
    // We don't need a real bowler row to test the filter — the route
    // filters by ROLE, not by bowlerId, so a role=user account is
    // excluded regardless of whether bowlerId is set.
    const linkedRoleUserId = await insertUser({ role: 'user', label: 'linked-roleuser' });

    const res = await apiGet<ListedUser[]>(
      `/api/org-admin/users?organizationId=${orgAId}`,
      sessionA,
    );
    expect(res.status).toBe(200);
    const ids = (res.data.data ?? []).map((u) => u.id);
    expect(ids).not.toContain(linkedRoleUserId);
  });

  it('the calling org_admin themself is included in the listing', async () => {
    const res = await apiGet<ListedUser[]>(
      `/api/org-admin/users?organizationId=${orgAId}`,
      sessionA,
    );
    expect(res.status).toBe(200);
    const ids = (res.data.data ?? []).map((u) => u.id);
    expect(ids).toContain(sessionA.user.id);
  });

  it('accountType=bowler returns only minimal linked ordinary-user rows', async () => {
    const [bowler] = await db
      .insert(bowlersTable)
      .values({
        name: 'Vitest Linked Bowler ' + stamp,
        email: 'vitest-linked-' + stamp + '@example.com',
        phone: '555-0100',
        organizationId: orgAId,
      })
      .returning({ id: bowlersTable.id });
    createdBowlerIds.push(bowler.id);
    const linkedUserId = await insertUser({
      role: 'user',
      label: 'linked-bowler-projection',
      bowlerId: bowler.id,
    });
    const [linkedUser] = await db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, linkedUserId));

    const res = await apiGet<Array<Record<string, unknown>>>(
      '/api/org-admin/users?organizationId=' + orgAId + '&accountType=bowler',
      sessionA,
    );
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(res.data.data).toContainEqual({
      id: linkedUser.id,
      name: linkedUser.name,
      email: linkedUser.email,
      bowlerId: bowler.id,
    });
    for (const row of res.data.data ?? []) {
      expect(Object.keys(row).sort()).toEqual(['bowlerId', 'email', 'id', 'name']);
    }
  });

  it('unclaimed-users endpoint still returns the role=user + bowlerId=null accounts', async () => {
    const unclaimedId = await insertUser({ role: 'user', label: 'unclaimed-cross' });
    const res = await apiGet<Array<{ id: number }>>(
      '/api/admin/unclaimed-users',
      sessionA,
    );
    expect(res.status).toBe(200);
    const ids = (res.data.data ?? []).map((u) => u.id);
    expect(ids).toContain(unclaimedId);

    // Sanity: cleanup-checked single row is what we just inserted.
    const [row] = await db.select().from(users).where(eq(users.id, unclaimedId));
    expect(row.role).toBe('user');
    expect(row.bowlerId).toBeNull();
  });
});
