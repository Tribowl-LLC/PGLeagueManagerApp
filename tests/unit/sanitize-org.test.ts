import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { sanitizeOrg } from '../../server/utils/api';
import { organizations, insertOrganizationSchema, type Organization } from '@shared/schema';

// Field-name patterns we never want to leak in any organization-facing
// response. Broadened (task #327) to also catch `apiKey`,
// `clientSecret`, `webhookKey`, `credentials`, `authConfig`, etc.
// The implementation now uses an allowlist projection (`pick`), so
// anything not on the safe list is already dropped — this regex is
// the schema-side belt-and-suspenders.
const SENSITIVE_NAME_PATTERN = /token|secret|password|key|credential|auth/i;
// Benign columns whose names happen to match the broadened pattern
// but are safe to return. Add only with explicit justification.
const SENSITIVE_NAME_ALLOWLIST = new Set<string>([]);

// Build a fully-populated `Organization` so the test exercises every
// column the schema currently defines. Adding a new sensitive-looking
// column to `shared/schema/organizations.ts` immediately trips the
// schema-walk test below.
//
// Routed through `insertOrganizationSchema.parse(...)` (task #693) so a
// future required column added to `shared/schema/organizations.ts`
// fails LOUDLY here instead of rotting silently behind TypeScript's
// structural type check.
function makeFullyPopulatedOrg(): Organization {
  const parsed = insertOrganizationSchema.parse({
    name: 'Audit Org',
    slug: 'audit-org',
    subdomain: 'audit',
    address: '123 Lane',
    city: 'Audit',
    state: 'NY',
    zipCode: '10001',
    phone: '+15555550100',
    email: 'org@example.com',
    logo: 'logo-url',
    darkLogo: 'dark-logo-url',
    appIcon: 'app-icon-url',
    active: true,
  });
  // `id` and `createdAt` are omitted from the insert schema, so we re-add
  // them to satisfy the SELECT type.
  return Object.assign(
    { id: 1, createdAt: '2024-01-01T00:00:00.000Z' },
    parsed,
  ) as Organization;
}

describe('sanitizeOrg', () => {
  it('preserves the safe fields', () => {
    const sanitized = sanitizeOrg(makeFullyPopulatedOrg());
    expect(sanitized.id).toBe(1);
    expect(sanitized.name).toBe('Audit Org');
    expect(sanitized.slug).toBe('audit-org');
    expect(sanitized.subdomain).toBe('audit');
    expect(sanitized.email).toBe('org@example.com');
    expect(sanitized.active).toBe(true);
  });

  it('never returns any field whose name looks sensitive', () => {
    const sanitized = sanitizeOrg(makeFullyPopulatedOrg());
    const leaked = Object.keys(sanitized).filter(k => SENSITIVE_NAME_PATTERN.test(k));
    expect(leaked, `sanitizeOrg leaked sensitive-looking fields: ${leaked.join(', ')}`).toEqual([]);
  });

  // Pin the contract to the live Drizzle schema: if a new column on
  // `organizations` is added with a name matching the sensitive
  // pattern, this test fails until either `sanitizeOrg` strips it or
  // the column is renamed.
  it('strips every column on the organizations schema whose name looks sensitive', () => {
    const cols = Object.keys(getTableColumns(organizations));
    const sensitiveCols = cols.filter(
      c => SENSITIVE_NAME_PATTERN.test(c) && !SENSITIVE_NAME_ALLOWLIST.has(c),
    );
    const fakeOrg = Object.fromEntries(cols.map(c => [c, `__${c}__`])) as unknown as Organization;
    const sanitized = sanitizeOrg(fakeOrg) as Record<string, unknown>;
    for (const col of sensitiveCols) {
      expect(
        sanitized,
        `organizations.${col} matches the sensitive name pattern but sanitizeOrg still returns it`,
      ).not.toHaveProperty(col);
    }
  });

  // Deny-by-default contract for the new allowlist projection (task
  // #327). Mirrors the user-side test: a column with a name the regex
  // doesn't catch (e.g. `apiKey`, `webhookKey`, `credentials`) must
  // still be dropped because it isn't on the safe list.
  it('drops any field that is not on the allowlist, even if its name does not look sensitive', () => {
    const sneaky = {
      id: 1,
      name: 'Org',
      slug: 'org',
      apiKey: 'sk_live_should_not_leak',
      clientSecret: 'cs_should_not_leak',
      webhookKey: 'whk_should_not_leak',
      credentials: { user: 'a', pass: 'b' },
      authConfig: { provider: 'oauth', clientSecret: 'leak' },
      arbitraryFutureColumn: 'should also be dropped',
    } as unknown as Organization;
    const sanitized = sanitizeOrg(sneaky) as Record<string, unknown>;
    expect(sanitized).not.toHaveProperty('apiKey');
    expect(sanitized).not.toHaveProperty('clientSecret');
    expect(sanitized).not.toHaveProperty('webhookKey');
    expect(sanitized).not.toHaveProperty('credentials');
    expect(sanitized).not.toHaveProperty('authConfig');
    expect(sanitized).not.toHaveProperty('arbitraryFutureColumn');
    expect(sanitized.id).toBe(1);
    expect(sanitized.name).toBe('Org');
  });

  it('does not mutate the input organization', () => {
    const input = makeFullyPopulatedOrg();
    const snapshot = JSON.parse(JSON.stringify(input));
    sanitizeOrg(input);
    expect(input).toEqual(snapshot);
  });
});
