import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { sanitizeBowler, sanitizeBowlers } from '../../server/utils/api';
import { bowlers, insertBowlerSchema, type Bowler } from '@shared/schema';

// Mirror of the regex used by tests/unit/sanitize-user.test.ts.
const SENSITIVE_NAME_PATTERN = /token|secret|password|key|credential|auth/i;
const SENSITIVE_NAME_ALLOWLIST = new Set<string>([]);

// Build a fully-populated `Bowler` so the test exercises every column the
// schema currently defines. Adding a new sensitive-looking column to
// `shared/schema/bowlers.ts` immediately trips the test below.
//
// Routed through `insertBowlerSchema.parse(...)` (task #693) so a future
// required column added to `shared/schema/bowlers.ts` fails LOUDLY here
// instead of rotting silently behind TypeScript's structural type check.
function makeFullyPopulatedBowler(): Bowler {
  const parsed = insertBowlerSchema.parse({
    name: 'Audit Bowler',
    email: 'audit@example.com',
    phone: '+15555550100',
    active: true,
    order: 0,
    organizationId: 7,
    paymentCustomerId: 'sq-customer-id',
    paymentProviderLocationId: 3,
    paymentSyncPendingAt: '2024-01-01T00:00:00.000Z',
    paymentSyncAttempts: 2,
    paymentSyncLastAttemptAt: '2024-01-01T00:00:00.000Z',
    paymentSyncNextRetryAt: '2024-01-01T00:02:00.000Z',
  });
  // `id` is omitted from the insert schema, so we re-add it to satisfy
  // the SELECT type. `Object.assign` (instead of an object literal) keeps
  // the lint rule against object-literal `as` casts happy.
  return Object.assign({ id: 1 }, parsed) as Bowler;
}

describe('sanitizeBowler', () => {
  it('strips the known sensitive / non-public fields', () => {
    const sanitized = sanitizeBowler(makeFullyPopulatedBowler()) as Record<string, unknown>;
    // Internal routing data for the deletion service. No UI consumer.
    expect(sanitized).not.toHaveProperty('paymentProviderLocationId');
  });

  it('preserves the safe identity / contact fields', () => {
    const sanitized = sanitizeBowler(makeFullyPopulatedBowler());
    expect(sanitized.id).toBe(1);
    expect(sanitized.name).toBe('Audit Bowler');
    expect(sanitized.email).toBe('audit@example.com');
    expect(sanitized.phone).toBe('+15555550100');
    expect(sanitized.active).toBe(true);
    expect(sanitized.order).toBe(0);
    expect(sanitized.organizationId).toBe(7);
  });

  it('preserves the operational identifiers the bowlers / admin UI consumes', () => {
    // These fields power the Square dashboard link and payment-sync
    // retry status. Dropping them would silently break the UI.
    const sanitized = sanitizeBowler(makeFullyPopulatedBowler());
    expect(sanitized.paymentCustomerId).toBe('sq-customer-id');
    expect(sanitized.paymentSyncPendingAt).toBe('2024-01-01T00:00:00.000Z');
    expect(sanitized.paymentSyncAttempts).toBe(2);
    expect(sanitized.paymentSyncLastAttemptAt).toBe('2024-01-01T00:00:00.000Z');
    expect(sanitized.paymentSyncNextRetryAt).toBe('2024-01-01T00:02:00.000Z');
  });

  it('never returns any field whose name looks sensitive', () => {
    const sanitized = sanitizeBowler(makeFullyPopulatedBowler());
    const leaked = Object.keys(sanitized).filter(k => SENSITIVE_NAME_PATTERN.test(k));
    expect(leaked, `sanitizeBowler leaked sensitive-looking fields: ${leaked.join(', ')}`).toEqual([]);
  });

  // Pin the contract to the live Drizzle schema: if a new column on
  // `bowlers` is added with a name matching the sensitive pattern,
  // this test fails until either `sanitizeBowler` strips it or the
  // column is renamed.
  it('strips every column on the bowlers schema whose name looks sensitive', () => {
    const cols = Object.keys(getTableColumns(bowlers));
    const sensitiveCols = cols.filter(
      c => SENSITIVE_NAME_PATTERN.test(c) && !SENSITIVE_NAME_ALLOWLIST.has(c),
    );
    const fakeBowler = Object.fromEntries(cols.map(c => [c, `__${c}__`])) as unknown as Bowler;
    const sanitized = sanitizeBowler(fakeBowler) as Record<string, unknown>;
    for (const col of sensitiveCols) {
      expect(
        sanitized,
        `bowlers.${col} matches the sensitive name pattern but sanitizeBowler still returns it`,
      ).not.toHaveProperty(col);
    }
  });

  // Deny-by-default contract for the new allowlist projection (task
  // #381). A future column slipped in with a name the regex doesn't
  // catch must STILL be dropped, because it isn't on the safe list.
  it('drops any field that is not on the allowlist, even if its name does not look sensitive', () => {
    const sneaky = {
      id: 1,
      name: 'Audit Bowler',
      organizationId: 7,
      // None of these names match the sensitive regex, but each is a
      // plausible secret-bearing column name we might accidentally add.
      stripeCustomerId: 'cus_should_not_leak',
      providerVaultRef: 'vault_should_not_leak',
      saml: { nameId: 'leak' },
      arbitraryFutureColumn: 'should also be dropped',
    } as unknown as Bowler;
    const sanitized = sanitizeBowler(sneaky) as Record<string, unknown>;
    expect(sanitized).not.toHaveProperty('stripeCustomerId');
    expect(sanitized).not.toHaveProperty('providerVaultRef');
    expect(sanitized).not.toHaveProperty('saml');
    expect(sanitized).not.toHaveProperty('arbitraryFutureColumn');
    expect(sanitized.id).toBe(1);
    expect(sanitized.name).toBe('Audit Bowler');
  });

  it('does not mutate the input bowler', () => {
    const input = makeFullyPopulatedBowler();
    const snapshot = JSON.parse(JSON.stringify(input));
    sanitizeBowler(input);
    expect(input).toEqual(snapshot);
  });

  it('sanitizeBowlers applies the projection to every element', () => {
    const a = makeFullyPopulatedBowler();
    const b = { ...makeFullyPopulatedBowler(), id: 2, name: 'Second Bowler' };
    const sanitized = sanitizeBowlers([a, b]) as Record<string, unknown>[];
    expect(sanitized).toHaveLength(2);
    for (const row of sanitized) {
      expect(row).not.toHaveProperty('paymentProviderLocationId');
    }
    expect(sanitized[0].id).toBe(1);
    expect(sanitized[1].id).toBe(2);
  });
});
