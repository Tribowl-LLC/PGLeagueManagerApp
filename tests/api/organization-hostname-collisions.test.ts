import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { like } from 'drizzle-orm';
import { db } from '../../server/db';
import { organizations, type InsertOrganization } from '@shared/schema';
import { storage } from '../../server/storage';
import { OrganizationHostnameConflictError } from '../../server/storage/organizations';
import { getPgErrorCode, getPgErrorConstraint } from '../../server/utils/db-errors';
import {
  apiPost,
  login,
  type AuthSession,
  TEST_ADMIN_EMAIL,
  TEST_ADMIN_PASSWORD,
} from '../helpers';

const PREFIX = 'vitesthostns';

function org(slug: string, subdomain: string | null): InsertOrganization {
  return {
    name: `Hostname namespace ${slug}`,
    slug,
    subdomain,
    active: true,
  };
}

async function cleanup(): Promise<void> {
  await db.delete(organizations).where(like(organizations.slug, `${PREFIX}%`));
}

describe.sequential('organization hostname namespace', () => {
  let adminSession: AuthSession;

  beforeAll(async () => {
    await cleanup();
    adminSession = await login(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD);
  });

  afterAll(cleanup);

  it('rejects create when a new slug collides with another organization subdomain', async () => {
    await storage.createOrganization(org(`${PREFIX}createsluga`, `${PREFIX}shareda`));

    await expect(storage.createOrganization(org(`${PREFIX}shareda`, `${PREFIX}createslugb`)))
      .rejects.toBeInstanceOf(OrganizationHostnameConflictError);
  });

  it('rejects create when a new subdomain collides with another organization slug', async () => {
    await storage.createOrganization(org(`${PREFIX}sharedb`, `${PREFIX}createsubdomaina`));

    await expect(storage.createOrganization(org(`${PREFIX}createsubdomainb`, `${PREFIX}sharedb`)))
      .rejects.toBeInstanceOf(OrganizationHostnameConflictError);
  });

  it('rejects both update collision directions', async () => {
    const slugOwner = await storage.createOrganization(org(`${PREFIX}updatesharedslug`, `${PREFIX}updatesuba`));
    const subdomainOwner = await storage.createOrganization(org(`${PREFIX}updateslugb`, `${PREFIX}updatesharedsub`));
    const target = await storage.createOrganization(org(`${PREFIX}updatetarget`, `${PREFIX}updatetargetsub`));
    if (subdomainOwner.subdomain === null) throw new Error('Expected subdomain fixture');

    await expect(storage.updateOrganization(target.id, { slug: subdomainOwner.subdomain }))
      .rejects.toBeInstanceOf(OrganizationHostnameConflictError);
    await expect(storage.updateOrganization(target.id, { subdomain: slugOwner.slug }))
      .rejects.toBeInstanceOf(OrganizationHostnameConflictError);
  });

  it('allows one organization to use the same slug and subdomain', async () => {
    const hostname = `${PREFIX}sameorg`;
    const created = await storage.createOrganization(org(hostname, hostname));
    expect(created).toMatchObject({ slug: hostname, subdomain: hostname });
  });

  it('enforces normalized lowercase identifiers for direct database writes', async () => {
    await expect(db.insert(organizations).values({
      name: 'Mixed case direct write',
      slug: `${PREFIX}MixedCase`,
      subdomain: null,
    })).rejects.toSatisfy((error: unknown) =>
      getPgErrorCode(error) === '23514'
      && getPgErrorConstraint(error) === 'organization_hostname_namespace_lowercase');
  });

  it('serializes concurrent opposite-direction creates so exactly one succeeds', async () => {
    const shared = `${PREFIX}concurrent`;
    const results = await Promise.allSettled([
      storage.createOrganization(org(`${PREFIX}concurrentsluga`, shared)),
      storage.createOrganization(org(shared, `${PREFIX}concurrentsubb`)),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: expect.any(OrganizationHostnameConflictError),
    });
  });

  it('returns a stable 409 without disclosing the owning organization', async () => {
    const shared = `${PREFIX}apishared`;
    await storage.createOrganization(org(`${PREFIX}apiexisting`, shared));

    const response = await apiPost('/api/organizations', {
      name: 'Conflicting API organization',
      slug: shared,
      subdomain: `${PREFIX}apinew`,
    }, adminSession);

    expect(response.status).toBe(409);
    expect(response.data).toEqual({
      success: false,
      error: {
        code: 'ORG_HOSTNAME_CONFLICT',
        message: 'Organization hostname is already in use',
      },
    });
    expect(JSON.stringify(response.data)).not.toContain(`${PREFIX}apiexisting`);
  });
});
