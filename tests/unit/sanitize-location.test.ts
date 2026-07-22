import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { sanitizeLocation, sanitizeLocations } from '../../server/utils/api';
import { locations, insertLocationSchema, updateLocationSchema, type Location } from '@shared/schema';

// Mirror of the regex used by tests/unit/sanitize-user.test.ts. Field-
// name patterns we never want to leak in any user-facing response.
const SENSITIVE_NAME_PATTERN = /token|secret|password|key|credential|auth/i;
// Benign columns whose names happen to match the broadened pattern but
// are safe to return. Add here only with explicit justification.
const SENSITIVE_NAME_ALLOWLIST = new Set<string>([]);

// Build a fully-populated `Location` so the test exercises every column the
// schema currently defines. Adding a new sensitive-looking column to
// `shared/schema/locations.ts` immediately trips the test below.
//
// Routed through `insertLocationSchema.parse(...)` (task #693) so a
// future required column added to `shared/schema/locations.ts` fails
// LOUDLY here instead of rotting silently behind TypeScript's structural
// type check.
function makeFullyPopulatedLocation(): Location {
  const parsed = insertLocationSchema.parse({
    name: 'Main Lanes',
    address: '123 Pin St',
    city: 'Springfield',
    state: 'IL',
    zipCode: '62701',
    phone: '+15555550100',
    active: true,
    organizationId: 7,
    squareCredentials: {
      appId: 'sq-app-id-do-not-leak',
      accessToken: 'sq-access-token-do-not-leak',
      locationId: 'sq-location-id-do-not-leak',
    },
  });
  // `id` is omitted from the insert schema, so we re-add it to satisfy
  // the SELECT type.
  return Object.assign({ id: 1 }, parsed) as Location;
}

describe('sanitizeLocation', () => {
  it('strips the known sensitive fields', () => {
    const sanitized = sanitizeLocation(makeFullyPopulatedLocation()) as Record<string, unknown>;
    expect(sanitized).not.toHaveProperty('squareCredentials');
  });

  it('rejects retired provider-selection fields at create and update boundaries', () => {
    const retiredFields = {
      paymentProvider: 'clover',
      cloverCredentials: { merchantId: 'retired' },
    };
    expect(insertLocationSchema.safeParse({
      name: 'Main Lanes',
      organizationId: 7,
      ...retiredFields,
    }).success).toBe(false);
    expect(updateLocationSchema.safeParse(retiredFields).success).toBe(false);
  });

  it('preserves the safe fields', () => {
    const sanitized = sanitizeLocation(makeFullyPopulatedLocation());
    expect(sanitized.id).toBe(1);
    expect(sanitized.name).toBe('Main Lanes');
    expect(sanitized.address).toBe('123 Pin St');
    expect(sanitized.city).toBe('Springfield');
    expect(sanitized.state).toBe('IL');
    expect(sanitized.zipCode).toBe('62701');
    expect(sanitized.phone).toBe('+15555550100');
    expect(sanitized.active).toBe(true);
    expect(sanitized.organizationId).toBe(7);
  });

  it('never returns any field whose name looks sensitive', () => {
    const sanitized = sanitizeLocation(makeFullyPopulatedLocation());
    const leaked = Object.keys(sanitized).filter(k => SENSITIVE_NAME_PATTERN.test(k));
    expect(leaked, `sanitizeLocation leaked sensitive-looking fields: ${leaked.join(', ')}`).toEqual([]);
  });

  // Pin the contract to the live Drizzle schema: if a new column on
  // `locations` is added with a name matching the sensitive pattern,
  // this test fails until either `sanitizeLocation` strips it or the
  // column is renamed.
  it('strips every column on the locations schema whose name looks sensitive', () => {
    const cols = Object.keys(getTableColumns(locations));
    const sensitiveCols = cols.filter(
      c => SENSITIVE_NAME_PATTERN.test(c) && !SENSITIVE_NAME_ALLOWLIST.has(c),
    );
    const fakeLocation = Object.fromEntries(cols.map(c => [c, `__${c}__`])) as unknown as Location;
    const sanitized = sanitizeLocation(fakeLocation) as Record<string, unknown>;
    for (const col of sensitiveCols) {
      expect(
        sanitized,
        `locations.${col} matches the sensitive name pattern but sanitizeLocation still returns it`,
      ).not.toHaveProperty(col);
    }
  });

  // Deny-by-default contract for the new allowlist projection (task
  // #381). A future column slipped in with a name the regex doesn't
  // catch (e.g. `webhookUrl` carrying a signed query, or
  // `providerConfig` JSONB) must STILL be dropped, because it isn't
  // on the safe list.
  it('drops any field that is not on the allowlist, even if its name does not look sensitive', () => {
    const sneaky = {
      id: 1,
      name: 'Main Lanes',
      organizationId: 7,
      // None of these names match the sensitive regex, but every
      // single one is a plausible secret-bearing column name.
      webhookUrl: 'https://hooks.example.com/sk_live_should_not_leak',
      providerConfig: { merchantId: 'm', apiSecret: 'leak' },
      stripeAccountId: 'acct_should_not_leak',
      arbitraryFutureColumn: 'should also be dropped',
    } as unknown as Location;
    const sanitized = sanitizeLocation(sneaky) as Record<string, unknown>;
    expect(sanitized).not.toHaveProperty('webhookUrl');
    expect(sanitized).not.toHaveProperty('providerConfig');
    expect(sanitized).not.toHaveProperty('stripeAccountId');
    expect(sanitized).not.toHaveProperty('arbitraryFutureColumn');
    // Safe fields still pass through.
    expect(sanitized.id).toBe(1);
    expect(sanitized.name).toBe('Main Lanes');
    expect(sanitized.organizationId).toBe(7);
  });

  it('does not mutate the input location', () => {
    const input = makeFullyPopulatedLocation();
    const snapshot = JSON.parse(JSON.stringify(input));
    sanitizeLocation(input);
    expect(input).toEqual(snapshot);
  });

  it('sanitizeLocations applies the projection to every element', () => {
    const a = makeFullyPopulatedLocation();
    const b = { ...makeFullyPopulatedLocation(), id: 2, name: 'Second Lanes' };
    const sanitized = sanitizeLocations([a, b]) as Record<string, unknown>[];
    expect(sanitized).toHaveLength(2);
    for (const row of sanitized) {
      expect(row).not.toHaveProperty('squareCredentials');
    }
    expect(sanitized[0].id).toBe(1);
    expect(sanitized[1].id).toBe(2);
  });
});
