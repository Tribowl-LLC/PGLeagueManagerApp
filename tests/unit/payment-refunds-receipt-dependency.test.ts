/**
 * Task #503 — verifies refund behavior on the receipt-email axis.
 *
 * Square's hosted refund-receipt email fires automatically only when
 * the ORIGINAL payment carried a buyer email. Our refund route does
 * NOT try to send a refund email on its own and does NOT inspect or
 * re-send the original buyerEmail to Square.
 *
 * Coverage:
 *  - Refund of a row with receiptEmailMissing=true succeeds and
 *    delegates to provider.refundPayment without attempting any
 *    extra email send (UX warning lives in refund-payment-dialog).
 *  - Refund of a row with receiptEmailMissing=false succeeds the
 *    same way (Square will auto-email the refund receipt).
 */
import {
  afterAll, afterEach, beforeAll, beforeEach,
  describe, expect, it, vi,
} from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const mockStorage = {
  getPaymentById: vi.fn(),
  getLeague: vi.fn(),
  refundPayment: vi.fn(),
};
vi.mock('../../server/storage', () => ({ storage: mockStorage }));

const mockHasAccessToPayment = vi.fn();
// Keep the real pure role-check helpers (isSystemAdmin, isOrgOrHigher) via
// importOriginal; the refund route uses these helpers, so a
// bare partial mock drifts and throws "No <export> defined on mock".
vi.mock('../../server/utils/access-control', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/utils/access-control')>();
  return {
    ...actual,
    hasAccessToPayment: (...a: unknown[]) => mockHasAccessToPayment(...a),
  };
});

vi.mock('../../server/middleware/rate-limit', () => ({
  paymentWriteLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const mockProvider = {
  providerName: 'square' as const,
  refundPayment: vi.fn(),
};
const mockGetPaymentProvider = vi.fn();
class FakeProviderNotConfigured extends Error {
  constructor(m: string) { super(m); this.name = 'ProviderNotConfiguredError'; }
}
vi.mock('../../server/services/payment-provider-factory', () => ({
  getPaymentProvider: (...a: unknown[]) => mockGetPaymentProvider(...a),
  ProviderNotConfiguredError: FakeProviderNotConfigured,
}));

// eslint-disable-next-line local/factory-must-use-schema -- mocked logger, not a schema row
const fakeLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
vi.mock('../../server/logger', () => ({ logger: fakeLogger, createLogger: () => fakeLogger }));

const refundsRouter = (await import('../../server/routes/payments/payment-refunds')).default;

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const raw = req.header('x-test-user');
    if (raw) (req as unknown as { user: unknown }).user = JSON.parse(raw);
    next();
  });
  app.use('/api/payments', refundsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

beforeEach(() => {
  for (const fn of Object.values(mockStorage)) (fn as ReturnType<typeof vi.fn>).mockReset();
  mockHasAccessToPayment.mockReset();
  mockGetPaymentProvider.mockReset();
  (mockProvider.refundPayment as ReturnType<typeof vi.fn>).mockReset();

  mockHasAccessToPayment.mockResolvedValue(true);
  mockGetPaymentProvider.mockResolvedValue(mockProvider);
  mockStorage.getLeague.mockResolvedValue({ id: 11, locationId: 99 });
  mockProvider.refundPayment.mockResolvedValue({ refundId: 'sq_rfnd_1', status: 'COMPLETED' });
});

afterEach(() => vi.clearAllMocks());

const ADMIN = { id: 1, role: 'org_admin', organizationId: 1, bowlerId: null };

async function postRefund(id: number, body: Record<string, unknown> = {}) {
  return fetch(`${baseUrl}/api/payments/${id}/refund`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-test-user': JSON.stringify(ADMIN),
    },
    body: JSON.stringify(body),
  });
}

describe('POST /api/payments/:id/refund — receipt-email dependency (Task #503)', () => {
  it('refunds a Square charge that had no buyer email (receiptEmailMissing=true) and does not attempt extra email send', async () => {
    mockStorage.getPaymentById.mockResolvedValue({
      id: 555, status: 'paid', type: 'square', leagueId: 11, amount: 2000,
      providerPaymentId: 'sq_pay_no_email', receiptEmailMissing: true, receiptUrl: null,
    });
    mockStorage.refundPayment.mockResolvedValue({ id: 555, status: 'refunded', refundId: 'sq_rfnd_1' });

    const res = await postRefund(555, { reason: 'Customer request' });

    expect(res.status).toBe(200);
    expect(mockProvider.refundPayment).toHaveBeenCalledWith('sq_pay_no_email', 2000, 'Customer request');
    // The refund route must not pass a buyer email to the provider
    // (the provider signature has no email param) — this assertion
    // also locks the contract for future contributors.
    expect(mockProvider.refundPayment).toHaveBeenCalledTimes(1);
    expect(mockProvider.refundPayment.mock.calls[0]).toHaveLength(3);
    expect(mockStorage.refundPayment).toHaveBeenCalledWith(555, 'sq_rfnd_1', 'Customer request');
  });

  it('refunds a Square charge that had a buyer email (receiptEmailMissing=false) using the same provider call', async () => {
    mockStorage.getPaymentById.mockResolvedValue({
      id: 556, status: 'paid', type: 'square', leagueId: 11, amount: 1500,
      providerPaymentId: 'sq_pay_with_email', receiptEmailMissing: false,
      receiptUrl: 'https://squareup.com/receipt/preview/sq_pay_with_email',
    });
    mockStorage.refundPayment.mockResolvedValue({ id: 556, status: 'refunded', refundId: 'sq_rfnd_2' });
    mockProvider.refundPayment.mockResolvedValue({ refundId: 'sq_rfnd_2', status: 'COMPLETED' });

    const res = await postRefund(556, { reason: 'Duplicate charge' });

    expect(res.status).toBe(200);
    expect(mockProvider.refundPayment).toHaveBeenCalledWith('sq_pay_with_email', 1500, 'Duplicate charge');
  });
});
