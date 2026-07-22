import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { sanitizePayment, sanitizePayments } from '../../server/utils/api';
import { payments, insertPaymentSchema, type Payment } from '@shared/schema';

// Mirror of the regex used by tests/unit/sanitize-{user,location,bowler}.test.ts.
const SENSITIVE_NAME_PATTERN = /token|secret|password|key|credential|auth/i;
// Benign columns whose names happen to match the broadened pattern but
// are safe to return. Add here only with explicit justification.
const SENSITIVE_NAME_ALLOWLIST = new Set<string>([
  // Task #504: client-supplied dedupe key. The same client that
  // submitted it gets it echoed back on the deduplicated-success
  // response; it discloses nothing the caller didn't already have.
  'idempotencyKey',
]);

// Build a fully-populated `Payment` so the test exercises every column
// the schema currently defines. Adding a new sensitive-looking column
// to `shared/schema/payments.ts` immediately trips the schema-walk
// test below.
//
// Routed through `insertPaymentSchema.parse(...)` (task #693) so a
// future required column added to `shared/schema/payments.ts` fails
// LOUDLY here instead of rotting silently behind TypeScript's structural
// type check. `checkNumber` is excluded from the parse input because the
// extend-block schema makes it `z.string().optional()` (no null) even
// though the underlying column is nullable; we add it (and the other
// nullable-only stripe columns) back via `Object.assign` below.
function makeFullyPopulatedPayment(): Payment {
  const parsed = insertPaymentSchema.parse({
    bowlerId: 7,
    leagueId: 11,
    amount: 2500,
    lineageAmount: 500,
    prizeFundAmount: 300,
    weekOf: '2024-01-01T00:00:00.000Z',
    status: 'paid',
    type: 'square',
    providerPaymentId: 'sq-payment-id',
    idempotencyKey: 'idem-key-1',
    squareRefundId: null,
    refundReason: null,
    refundedAt: null,
    disputeId: null,
    disputedAt: null,
    receiptUrl: 'https://squareup.com/receipt/preview/abc',
    receiptNumber: 'rcpt-123',
    receiptEmailMissing: false,
    notes: 'admin note',
    paidByUserId: null,
  });
  // No `as Payment` cast: `Object.assign({...}, parsed)` already infers
  // a structural superset of `Payment`, so the lint rule against
  // unnecessary type assertions would flag a cast here.
  return Object.assign(
    {
      id: 1,
      checkNumber: null,
      createdAt: '2024-01-01T00:00:00.000Z',
    },
    parsed,
  );
}

describe('sanitizePayment', () => {
  // No current column on `payments` is off the allowlist (the
  // operational fields explanation lives in the SAFE_PAYMENT_FIELDS
  // doc-comment), so the "strip" half of the contract is exercised by
  // the sneaky-future-column case below. This case pins the inverse:
  // a hand-rolled response that bolted a new field onto the row would
  // get that field dropped at the boundary.
  it('drops any extraneous field that is not on the allowlist', () => {
    const sanitized = sanitizePayment({
      ...makeFullyPopulatedPayment(),
      arbitraryFutureColumn: 'should be dropped',
    } as unknown as Payment) as Record<string, unknown>;
    expect(sanitized).not.toHaveProperty('arbitraryFutureColumn');
  });

  it('preserves the safe identity / amount / status fields', () => {
    const sanitized = sanitizePayment(makeFullyPopulatedPayment());
    expect(sanitized.id).toBe(1);
    expect(sanitized.bowlerId).toBe(7);
    expect(sanitized.leagueId).toBe(11);
    expect(sanitized.amount).toBe(2500);
    expect(sanitized.lineageAmount).toBe(500);
    expect(sanitized.prizeFundAmount).toBe(300);
    expect(sanitized.weekOf).toBe('2024-01-01T00:00:00.000Z');
    expect(sanitized.status).toBe('paid');
    expect(sanitized.type).toBe('square');
    expect(sanitized.createdAt).toBe('2024-01-01T00:00:00.000Z');
  });

  it('preserves the operational fields the receipts / refund / sync UI consumes', () => {
    // `providerPaymentId` powers the Square dashboard deep-link in
    // bowler-payment-history-table.tsx and the lazy receipt backfill
    // in view-receipt-button.tsx;
    // `idempotencyKey` is echoed back on the deduplicated-success
    // response; `receiptUrl` / `receiptNumber` / `receiptEmailMissing`
    // drive the receipt UI; `checkNumber` / `notes` are admin-visible.
    // Dropping any of these would silently break the UI or the refund
    // flow.
    const sanitized = sanitizePayment(makeFullyPopulatedPayment());
    expect(sanitized.providerPaymentId).toBe('sq-payment-id');
    expect(sanitized.idempotencyKey).toBe('idem-key-1');
    expect(sanitized.receiptUrl).toBe('https://squareup.com/receipt/preview/abc');
    expect(sanitized.receiptNumber).toBe('rcpt-123');
    expect(sanitized.receiptEmailMissing).toBe(false);
    expect(sanitized.notes).toBe('admin note');
    expect(sanitized.checkNumber).toBeNull();
  });

  it('never returns any field whose name looks sensitive (modulo the operational allowlist)', () => {
    const sanitized = sanitizePayment(makeFullyPopulatedPayment());
    const leaked = Object.keys(sanitized).filter(
      k => SENSITIVE_NAME_PATTERN.test(k) && !SENSITIVE_NAME_ALLOWLIST.has(k),
    );
    expect(leaked, `sanitizePayment leaked sensitive-looking fields: ${leaked.join(', ')}`).toEqual([]);
  });

  // Pin the contract to the live Drizzle schema: if a new column on
  // `payments` is added with a name matching the sensitive pattern,
  // this test fails until either `sanitizePayment` strips it, the
  // column is renamed, or it is explicitly added to the operational
  // allowlist with a written justification.
  it('strips every column on the payments schema whose name looks sensitive', () => {
    const cols = Object.keys(getTableColumns(payments));
    const sensitiveCols = cols.filter(
      c => SENSITIVE_NAME_PATTERN.test(c) && !SENSITIVE_NAME_ALLOWLIST.has(c),
    );
    const fakePayment = Object.fromEntries(cols.map(c => [c, `__${c}__`])) as unknown as Payment;
    const sanitized = sanitizePayment(fakePayment) as Record<string, unknown>;
    for (const col of sensitiveCols) {
      expect(
        sanitized,
        `payments.${col} matches the sensitive name pattern but sanitizePayment still returns it`,
      ).not.toHaveProperty(col);
    }
  });

  // Deny-by-default contract for the new allowlist projection (task
  // #504). A future column slipped in with a name the regex doesn't
  // catch (e.g. `processorWebhookSecret`, `customerCardToken` —
  // those DO match, but `merchantApiId`, `vaultRef`, `payerProfile`
  // do not) must STILL be dropped, because it isn't on the safe
  // list. This is what makes the helper resistant to unconventional
  // column names.
  it('drops any field that is not on the allowlist, even if its name does not look sensitive', () => {
    const sneaky = {
      id: 1,
      bowlerId: 7,
      leagueId: 11,
      amount: 2500,
      // None of these names match the sensitive regex, but each is a
      // plausible secret-bearing column name we might accidentally add.
      vaultRef: 'vault_should_not_leak',
      payerProfile: { customerId: 'cus_leak', cardId: 'card_leak' },
      stripeChargeId: 'ch_should_not_leak',
      arbitraryFutureColumn: 'should also be dropped',
    } as unknown as Payment;
    const sanitized = sanitizePayment(sneaky) as Record<string, unknown>;
    expect(sanitized).not.toHaveProperty('vaultRef');
    expect(sanitized).not.toHaveProperty('payerProfile');
    expect(sanitized).not.toHaveProperty('stripeChargeId');
    expect(sanitized).not.toHaveProperty('arbitraryFutureColumn');
    expect(sanitized.id).toBe(1);
    expect(sanitized.bowlerId).toBe(7);
    expect(sanitized.leagueId).toBe(11);
    expect(sanitized.amount).toBe(2500);
  });

  it('does not mutate the input payment', () => {
    const input = makeFullyPopulatedPayment();
    const snapshot = JSON.parse(JSON.stringify(input));
    sanitizePayment(input);
    expect(input).toEqual(snapshot);
  });

  it('sanitizePayments applies the projection to every element', () => {
    const a = makeFullyPopulatedPayment();
    const b = { ...makeFullyPopulatedPayment(), id: 2, amount: 5000 };
    const sanitized = sanitizePayments([
      { ...a, arbitraryFutureColumn: 'leak1' } as unknown as Payment,
      { ...b, arbitraryFutureColumn: 'leak2' } as unknown as Payment,
    ]) as Record<string, unknown>[];
    expect(sanitized).toHaveLength(2);
    for (const row of sanitized) {
      expect(row).not.toHaveProperty('arbitraryFutureColumn');
    }
    expect(sanitized[0].id).toBe(1);
    expect(sanitized[0].amount).toBe(2500);
    expect(sanitized[1].id).toBe(2);
    expect(sanitized[1].amount).toBe(5000);
  });
});
