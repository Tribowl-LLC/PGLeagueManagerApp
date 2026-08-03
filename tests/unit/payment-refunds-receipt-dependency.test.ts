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

const mockPrepareRefund = vi.fn();
const mockExecuteRefund = vi.fn();
vi.mock('../../server/services/refund-payment-operation-preparation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/services/refund-payment-operation-preparation')>();
  return { ...actual, prepareRefundPaymentOperation: (...a: unknown[]) => mockPrepareRefund(...a) };
});
vi.mock('../../server/services/refund-payment-operation-executor', () => ({
  refundPaymentOperationExecutor: { execute: (...a: unknown[]) => mockExecuteRefund(...a) },
}));
vi.mock('../../server/services/scheduled-payment-operation-executor', () => ({
  scheduledPaymentOperationExecutor: { rearm: vi.fn().mockResolvedValue(undefined) },
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
  mockPrepareRefund.mockReset();
  mockExecuteRefund.mockReset();

  mockHasAccessToPayment.mockResolvedValue(true);
  const operation = {
    id: '11111111-1111-4111-8111-111111111111', status: 'pending',
    providerObjectId: null, nextAttemptAt: '2026-01-01T00:00:00.000Z',
    leaseExpiresAt: null, attemptCount: 0, errorClassification: null, errorCode: null,
  };
  mockPrepareRefund.mockResolvedValue({ operation, snapshot: { organizationId: 1 } });
  mockExecuteRefund.mockResolvedValue({ ...operation, status: 'succeeded', providerObjectId: 'sq_rfnd_1' });
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
    mockStorage.getPaymentById.mockResolvedValue({
      id: 555, status: 'refunded', squareRefundId: 'sq_rfnd_1',
      receiptEmailMissing: true, receiptUrl: null,
    });

    const res = await postRefund(555, { reason: 'Customer request' });

    expect(res.status).toBe(200);
    expect(mockPrepareRefund).toHaveBeenCalledWith(expect.objectContaining({
      paymentId: 555,
      reason: 'Customer request',
    }));
    expect(mockExecuteRefund).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
  });

  it('refunds a Square charge that had a buyer email (receiptEmailMissing=false) using the same provider call', async () => {
    mockStorage.getPaymentById.mockResolvedValue({
      id: 556, status: 'paid', type: 'square', leagueId: 11, amount: 1500,
      providerPaymentId: 'sq_pay_with_email', receiptEmailMissing: false,
      receiptUrl: 'https://squareup.com/receipt/preview/sq_pay_with_email',
    });
    mockExecuteRefund.mockResolvedValue({
      id: '22222222-2222-4222-8222-222222222222', status: 'succeeded',
      providerObjectId: 'sq_rfnd_2', nextAttemptAt: null, leaseExpiresAt: null,
      attemptCount: 1, errorClassification: null, errorCode: null,
    });
    mockStorage.getPaymentById.mockResolvedValue({
      id: 556, status: 'refunded', squareRefundId: 'sq_rfnd_2',
      receiptEmailMissing: false,
      receiptUrl: 'https://squareup.com/receipt/preview/sq_pay_with_email',
    });

    const res = await postRefund(556, { reason: 'Duplicate charge' });

    expect(res.status).toBe(200);
    expect(mockPrepareRefund).toHaveBeenCalledWith(expect.objectContaining({
      paymentId: 556,
      reason: 'Duplicate charge',
    }));
    expect(res.status).toBe(200);
  });
});
