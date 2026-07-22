/**
 * Pin for task #579 (Square parity for the #575 partial-config UX).
 *
 * GET /api/payments-provider/config now exposes a `providerConfigured`
 * boolean and a `missingFields` array for Square locations as well as
 * Square, so the payment form and settings page can show a friendly
 * "Square not fully configured" message instead of failing silently
 * at checkout.
 *
 * Without these pins, a future refactor that strips the new fields
 * (or only returns Square details when fully configured, as the
 * pre-#579 behavior did — falling through to env-var config) would
 * silently break the partial-config UX across the client.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { db } from '../../server/db';
import { locations } from '@shared/schema';
import {
  apiGet,
  login,
  TEST_ORG_A_EMAIL,
  TEST_ORG_PASSWORD,
} from '../helpers';
import { storage } from '../../server/storage';

import { z } from 'zod';

const squareConfigResponseSchema = z.object({
  providerConfigured: z.boolean(),
  missingFields: z.array(z.string()),
  appId: z.string().nullable().optional(),
  locationId: z.string().nullable().optional(),
  accessToken: z.string().nullable().optional(),
});
type SquareConfigResponse = z.infer<typeof squareConfigResponseSchema>;

function parseSquareConfig(data: unknown): SquareConfigResponse {
  return squareConfigResponseSchema.parse(data);
}

const createdLocationIds: number[] = [];

afterAll(async () => {
  if (createdLocationIds.length > 0) {
    await db.delete(locations).where(inArray(locations.id, createdLocationIds));
    createdLocationIds.length = 0;
  }
});

describe('GET /api/payments-provider/config — Square partial-config status (task #579)', () => {
  it('reports providerConfigured=false with the full missing-field list when no Square credentials are saved', async () => {
    const session = await login(TEST_ORG_A_EMAIL, TEST_ORG_PASSWORD);
    const orgId = session.user.organizationId;
    expect(orgId).toBeTruthy();
    if (!orgId) throw new Error("missing organizationId");

    const [loc] = await db
      .insert(locations)
      .values({
        name: `vitest-square-empty-${Date.now()}`,
        organizationId: orgId,
      })
      .returning();
    createdLocationIds.push(loc.id);

    const { status, data } = await apiGet<SquareConfigResponse>(
      `/api/payments-provider/config?locationId=${loc.id}`,
      session,
    );

    expect(status).toBe(200);
    const body = parseSquareConfig(data);
    expect(body.providerConfigured).toBe(false);
    expect(Array.isArray(body.missingFields)).toBe(true);
    expect(body.missingFields).toEqual(
      expect.arrayContaining(['appId', 'accessToken', 'locationId']),
    );
  });

  it('reports providerConfigured=false with only the missing fields when Square is partially configured', async () => {
    const session = await login(TEST_ORG_A_EMAIL, TEST_ORG_PASSWORD);
    const orgId = session.user.organizationId;
    expect(orgId).toBeTruthy();
    if (!orgId) throw new Error("missing organizationId");

    const [loc] = await db
      .insert(locations)
      .values({
        name: `vitest-square-partial-${Date.now()}`,
        organizationId: orgId,
      })
      .returning();
    createdLocationIds.push(loc.id);

    // App ID present, but no access token and no Square location ID —
    // the exact "broken card form" scenario task #579 is meant to
    // surface as a friendly notice instead of falling through to the
    // env-var Square config and silently using the wrong credentials.
    await storage.updateLocationSquareConfig(loc.id, {
      appId: 'sq0idp-partial',
    });

    const { status, data } = await apiGet<SquareConfigResponse>(
      `/api/payments-provider/config?locationId=${loc.id}`,
      session,
    );

    expect(status).toBe(200);
    const body = parseSquareConfig(data);
    expect(body.appId).toBe('sq0idp-partial');
    expect(body.providerConfigured).toBe(false);
    expect(body.missingFields).toEqual(
      expect.arrayContaining(['accessToken', 'locationId']),
    );
    expect(body.missingFields).not.toContain('appId');
  });

  it('reports providerConfigured=true and an empty missingFields array when Square is fully configured', async () => {
    const session = await login(TEST_ORG_A_EMAIL, TEST_ORG_PASSWORD);
    const orgId = session.user.organizationId;
    expect(orgId).toBeTruthy();
    if (!orgId) throw new Error("missing organizationId");

    const [loc] = await db
      .insert(locations)
      .values({
        name: `vitest-square-full-${Date.now()}`,
        organizationId: orgId,
      })
      .returning();
    createdLocationIds.push(loc.id);

    await storage.updateLocationSquareConfig(loc.id, {
      appId: 'sq0idp-full',
      accessToken: 'EAAAEv_full_secret_token',
      locationId: 'L_FULL',
    });

    const { status, data } = await apiGet<SquareConfigResponse>(
      `/api/payments-provider/config?locationId=${loc.id}`,
      session,
    );

    expect(status).toBe(200);
    const body = parseSquareConfig(data);
    expect(body.providerConfigured).toBe(true);
    expect(body.missingFields).toEqual([]);
    expect(body.appId).toBe('sq0idp-full');
    expect(body.locationId).toBe('L_FULL');
    // The Square access token is NEVER returned to the browser — the
    // route must only signal that one is configured via the
    // missingFields/providerConfigured pair.
    expect(body.accessToken).toBeUndefined();
  });
});
