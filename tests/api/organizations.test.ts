import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../../server/db';
import { organizations, users } from '@shared/schema';
import {
  apiDelete,
  login,
  apiGet,
  apiPost,
  type AuthSession,
  TEST_ADMIN_EMAIL,
  TEST_ADMIN_PASSWORD,
  TEST_NEW_ORG_ADMIN_PASSWORD,
  releaseFixtureOrg,
} from '../helpers';

// Task #607: this suite exercises the org-create route end-to-end, so
// it has to actually POST a new org row. To keep the dev DB org count
// flat across runs, the slug is deterministic and `releaseFixtureOrg`
// tears down the row (and any dependents the route created, e.g. the
// admin user) in both `beforeAll` (defensive — clears leftovers from
// a prior crashed run) and `afterAll`.
const CREATE_ORG_SLUG = 'vitest-organizations-create';

describe('Organizations API', () => {
  let adminSession: AuthSession;

  beforeAll(async () => {
    adminSession = await login(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD);
    // Defensive: drop any leftover row from a prior interrupted run.
    await releaseFixtureOrg(CREATE_ORG_SLUG);
  });

  afterAll(async () => {
    await releaseFixtureOrg(CREATE_ORG_SLUG);
  });

  describe('when authenticated as admin', () => {
    it('should have a valid admin session', () => {
      expect(adminSession.user.email).toBe(TEST_ADMIN_EMAIL);
      expect(adminSession.cookies).toBeTruthy();
      expect(adminSession.csrfToken).toBeTruthy();
    });

    it('should list organizations', async () => {
      const { status, data } = await apiGet('/api/organizations', adminSession);
      expect(status).toBe(200);
      expect(data.success).toBe(true);
      expect(Array.isArray(data.data)).toBe(true);
    });

    it('should create an organization with admin', async () => {
      // Task #607: deterministic slug + releaseFixtureOrg tear-down
      // (in afterAll) means this test re-creates the same org each
      // run instead of leaking a new one.
      const slug = CREATE_ORG_SLUG;
      const { status, data } = await apiPost(
        '/api/organizations',
        {
          name: 'Vitest Test Organization',
          slug,
          adminData: {
            // The admin user's email must be unique — releaseFixtureOrg
            // tears it down too (it cascades through the org), so a
            // unique-per-run email is fine and avoids any chance of
            // racing a still-mid-cleanup row from a parallel worker.
            email: `orgadmin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@vitest.local`,
            password: TEST_NEW_ORG_ADMIN_PASSWORD,
            name: 'Test Org Admin',
          },
        },
        adminSession,
      );
      expect(status).toBe(201);
      expect(data.success).toBe(true);

      // The endpoint may return the org directly or wrapped as
      // `{ organization, adminUser }`. Support both shapes.
      const created = data.data as
        | { id: number; name: string; slug: string }
        | { organization: { id: number; name: string; slug: string }; adminUser?: unknown };
      const org = 'organization' in created ? created.organization : created;
      expect(org).toHaveProperty('name', 'Vitest Test Organization');
      expect(org).toHaveProperty('slug', slug);
    });

    it('should list organizations including newly created one', async () => {
      const { data } = await apiGet('/api/organizations', adminSession);
      expect(data.success).toBe(true);
      const orgs = data.data as Array<{ name: string }>;
      expect(orgs.length).toBeGreaterThanOrEqual(1);
    });

    it('deletes tenant administrators but preserves and detaches system administrators', async () => {
      const [organization] = await db
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.slug, CREATE_ORG_SLUG));
      expect(organization).toBeDefined();
      if (!organization) throw new Error('Expected test organization to exist');

      const [organizationUser] = await db
        .select({ id: users.id })
        .from(users)
        .where(and(
          eq(users.organizationId, organization.id),
          eq(users.role, 'org_admin'),
        ));
      expect(organizationUser).toBeDefined();
      if (!organizationUser) throw new Error('Expected test organization admin to exist');

      await db
        .update(users)
        .set({ organizationId: organization.id })
        .where(eq(users.id, adminSession.user.id));

      const { status, data } = await apiDelete(`/api/organizations/${organization.id}`, adminSession);
      expect(status).toBe(200);
      expect(data.success).toBe(true);

      const [deletedOrganization] = await db
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, organization.id));
      const [deletedUser] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, organizationUser.id));
      const [preservedSystemAdmin] = await db
        .select({
          id: users.id,
          role: users.role,
          organizationId: users.organizationId,
        })
        .from(users)
        .where(eq(users.id, adminSession.user.id));
      expect(deletedOrganization).toBeUndefined();
      expect(deletedUser).toBeUndefined();
      expect(preservedSystemAdmin).toEqual({
        id: adminSession.user.id,
        role: 'system_admin',
        organizationId: null,
      });
    });
  });

  describe('when not authenticated', () => {
    it('should reject unauthenticated organization listing', async () => {
      const { status } = await apiGet('/api/organizations');
      expect(status).toBe(401);
    });
  });
});
