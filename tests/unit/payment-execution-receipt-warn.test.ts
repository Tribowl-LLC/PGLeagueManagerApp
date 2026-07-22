/**
 * Task #503 — `executeCharge` (used by autopay/scheduled charges)
 * must:
 *   1. Surface `receiptUrl` / `receiptNumber` from the provider on the
 *      `ChargeResult` so the caller can persist them.
 *   2. Set `buyerEmailMissing=true` and emit a `log.warn` whenever a
 *      Square charge runs without a buyer email — that's the
 *      observability hook ops uses to chase up missing receipts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const warnSpy = vi.fn();
// eslint-disable-next-line local/factory-must-use-schema -- mocked logger, not a schema row
const fakeLogger = {
  info: vi.fn(),
  warn: (...a: unknown[]) => warnSpy(...a),
  error: vi.fn(),
  debug: vi.fn(),
};
vi.mock('../../server/logger', () => ({
  logger: fakeLogger,
  createLogger: () => fakeLogger,
}));

const { executeCharge } = await import('../../server/services/payment-execution');

beforeEach(() => warnSpy.mockReset());

function makeProvider(overrides: Record<string, unknown> = {}) {
  return {
    providerName: 'square',
    processPayment: vi.fn().mockResolvedValue({
      id: 'pay_1', status: 'COMPLETED',
      receiptUrl: 'https://squareup.com/receipt/preview/pay_1',
      receiptNumber: 'NUM-001',
      providerRef: {},
    }),
    createOrderWithPayment: vi.fn().mockResolvedValue({
      id: 'pay_1', status: 'COMPLETED',
      receiptUrl: 'https://squareup.com/receipt/preview/pay_1',
      receiptNumber: 'NUM-001',
      providerRef: {},
    }),
    ...overrides,
  } as unknown as Parameters<typeof executeCharge>[0];
}

describe('executeCharge — receipt fields & missing-email warn (Task #503)', () => {
  it('warns and flags buyerEmailMissing when Square charge has no buyer email', async () => {
    const provider = makeProvider();
    const result = await executeCharge(provider, 'card_1', 2000, [], 'cust_1', undefined);

    expect(result.buyerEmailMissing).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
    const msg = String(warnSpy.mock.calls[0][0] ?? '');
    expect(msg).toMatch(/without buyer email/i);
  });

  it('returns receiptUrl/receiptNumber from the provider when buyer email present', async () => {
    const provider = makeProvider();
    const result = await executeCharge(provider, 'card_1', 2000, [], 'cust_1', 'pat@example.com');

    expect(result.buyerEmailMissing).toBe(false);
    expect(result.receiptUrl).toBe('https://squareup.com/receipt/preview/pay_1');
    expect(result.receiptNumber).toBe('NUM-001');
    expect(warnSpy).not.toHaveBeenCalled();
  });

});
