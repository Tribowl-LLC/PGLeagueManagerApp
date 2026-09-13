import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../server/db';
import { organizations, leagues } from '@shared/schema';
import { apiGet, acquireFixtureOrg, releaseFixtureOrg, BASE_URL } from '../helpers';

// Task #663: the public sign-up endpoints `/api/organizations/slug/:slug`
// and `/api/organizations/slug/:slug/leagues` must accept the org's
// `subdomain` value, not just its `slug`. Perfect Game has
// `subdomain = 'perfectgame'` and `slug = 'perfect-game'`, so the slug-only
// lookup misses and the sign-up dropdown comes back empty.
const FIXTURE_SLUG = 'vitest-pubslug-mismatch';
const FIXTURE_SUBDOMAIN = 'vitestpubsub';

// Smallest valid 1x1 PNG, used so /logo and /app-icon don't 404 when the
// org row exists but has no image.
const PNG_DATA_URI =
  'data:image/png;base64,' +
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

describe('Public org-by-slug endpoints accept subdomain (#663)', () => {
  let orgId: number;
  let leagueId: number;

  beforeAll(async () => {
    orgId = await acquireFixtureOrg(FIXTURE_SLUG, 'Vitest Public Slug Mismatch Org');
    await db
      .update(organizations)
      .set({ subdomain: FIXTURE_SUBDOMAIN, logo: PNG_DATA_URI, appIcon: PNG_DATA_URI })
      .where(eq(organizations.id, orgId));

    const [league] = await db
      .insert(leagues)
      .values({
        name: 'Vitest Public Signup League',
        organizationId: orgId,
        active: true,
        allowPublicSignup: true,
        seasonStart: '2030-01-07',
        seasonEnd: '2030-04-29',
        weekDay: 'Monday',
      })
      .returning({ id: leagues.id });
    leagueId = league.id;
  });

  afterAll(async () => {
    await releaseFixtureOrg(FIXTURE_SLUG);
  });

  it('resolves the org when called with subdomain (not slug)', async () => {
    const { status, data } = await apiGet(`/api/organizations/slug/${FIXTURE_SUBDOMAIN}`);
    expect(status).toBe(200);
    expect(data.success).toBe(true);
    const org = data.data as { id: number; slug: string };
    expect(org.id).toBe(orgId);
    expect(org.slug).toBe(FIXTURE_SLUG);
  });

  it('returns public-signup leagues when called with subdomain', async () => {
    const { status, data } = await apiGet(
      `/api/organizations/slug/${FIXTURE_SUBDOMAIN}/leagues`,
    );
    expect(status).toBe(200);
    expect(data.success).toBe(true);
    const list = data.data as Array<{ id: number; name: string }>;
    expect(list.some((l) => l.id === leagueId)).toBe(true);
  });

  it('still resolves the org when called with the slug', async () => {
    const { status, data } = await apiGet(`/api/organizations/slug/${FIXTURE_SLUG}`);
    expect(status).toBe(200);
    expect(data.success).toBe(true);
    const org = data.data as { id: number; slug: string };
    expect(org.id).toBe(orgId);
  });

  it('still returns public-signup leagues when called with the slug', async () => {
    const { status, data } = await apiGet(
      `/api/organizations/slug/${FIXTURE_SLUG}/leagues`,
    );
    expect(status).toBe(200);
    expect(data.success).toBe(true);
    const list = data.data as Array<{ id: number; name: string }>;
    expect(list.some((l) => l.id === leagueId)).toBe(true);
  });

  it('does not expose public-signup leagues for an archived organization', async () => {
    await db.update(organizations).set({ active: false }).where(eq(organizations.id, orgId));
    try {
      const bySubdomain = await apiGet(
        `/api/organizations/slug/${FIXTURE_SUBDOMAIN}/leagues`,
      );
      expect(bySubdomain.status).toBe(200);
      expect(bySubdomain.data.data).toEqual([]);

      const allPublicLeagues = await apiGet('/api/organizations/public-leagues');
      expect(allPublicLeagues.status).toBe(200);
      const list = allPublicLeagues.data.data as Array<{ id: number }>;
      expect(list.some((l) => l.id === leagueId)).toBe(false);
    } finally {
      await db.update(organizations).set({ active: true }).where(eq(organizations.id, orgId));
    }
  });

  // Task #665: the /logo and /app-icon variants must also accept the
  // subdomain value, mirroring the two endpoints above.
  for (const which of ['logo', 'app-icon'] as const) {
    it(`serves /${which} when called with subdomain (not slug)`, async () => {
      const res = await fetch(
        `${BASE_URL}/api/organizations/slug/${FIXTURE_SUBDOMAIN}/${which}`,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/^image\/png/);
    });

    it(`serves /${which} when called with the slug`, async () => {
      const res = await fetch(
        `${BASE_URL}/api/organizations/slug/${FIXTURE_SLUG}/${which}`,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/^image\/png/);
    });
  }
});
