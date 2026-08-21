/**
 * Task #503 — receipt endpoints under
 * `server/routes/payments-provider/receipts.ts`.
 *
 * Coverage:
 *  - GET  /payments/:id/receipt
 *      • cached receiptUrl returns immediately (no provider call).
 *      • lazy backfill via provider.getPayment + storage.updatePayment
 *        when row has providerPaymentId but no cached URL.
 *      • cash/check rows (no providerPaymentId) → 404 RECEIPT_UNAVAILABLE.
 *      • cross-org bowler (no access) → 403.
 *  - POST /payments/:id/resend-receipt
 *      • non-admin → 403 even if it's their own row.
 *      • invalid email body → 400.
 *      • happy path → 200 and `sendReceiptResendEmail` called with
 *        the resolved URL + payment metadata.
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
  getPaymentByIdForOrganization: vi.fn(),
  getPaymentsByPaymentOperationId: vi.fn(),
  getLeague: vi.fn(),
  getOrganization: vi.fn(),
  getBowler: vi.fn(),
  updatePayment: vi.fn(),
};
vi.mock('../../server/storage', () => ({ storage: mockStorage }));

const mockDb = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock('../../server/db.js', () => ({ db: mockDb }));

const mockHasAccessToPayment = vi.fn();
vi.mock('../../server/utils/access-control', () => ({
  hasAccessToPayment: (...a: unknown[]) => mockHasAccessToPayment(...a),
}));

vi.mock('../../server/middleware/rate-limit', () => ({
  paymentWriteLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const mockProvider = {
  providerName: 'square' as const,
  getPayment: vi.fn(),
};
const mockGetPaymentProvider = vi.fn();
class FakeProviderNotConfigured extends Error {
  constructor(m: string) { super(m); this.name = 'ProviderNotConfiguredError'; }
}
vi.mock('../../server/services/payment-provider-factory', () => ({
  getPaymentProvider: (...a: unknown[]) => mockGetPaymentProvider(...a),
  ProviderNotConfiguredError: FakeProviderNotConfigured,
}));

const mockSendReceiptResend = vi.fn();
vi.mock('../../server/services/email', () => ({
  sendReceiptResendEmail: (...a: unknown[]) => mockSendReceiptResend(...a),
}));

const receiptsRouter = (await import('../../server/routes/payments-provider/receipts')).default;

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
  app.use('/api/payments-provider', receiptsRouter);
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
  mockProvider.getPayment.mockReset();
  mockSendReceiptResend.mockReset();
  mockDb.select.mockReset();

  mockHasAccessToPayment.mockResolvedValue(true);
  mockGetPaymentProvider.mockResolvedValue(mockProvider);
  mockSendReceiptResend.mockResolvedValue(true);
  mockStorage.getLeague.mockResolvedValue({ id: 11, organizationId: 1, name: 'Wed Night', locationId: 99 });
  mockStorage.getOrganization.mockResolvedValue({ id: 1, name: 'Cosmic Lanes' });
  mockStorage.getBowler.mockResolvedValue({ id: 42, name: 'Pat', email: 'on-file@example.com' });
  mockStorage.getPaymentByIdForOrganization.mockImplementation((paymentId: number) => mockStorage.getPaymentById(paymentId));
  mockStorage.getPaymentsByPaymentOperationId.mockResolvedValue([]);
  mockDb.select.mockImplementation(() => dbResult([]));
});

afterEach(() => vi.clearAllMocks());

const ADMIN = { id: 1, role: 'org_admin', organizationId: 1, bowlerId: null };
const BOWLER = { id: 9, role: 'user', organizationId: 1, bowlerId: 42 };
const PARTNER = { id: 10, role: 'user', organizationId: 1, bowlerId: 43 };
const PAYER = { id: 100, role: 'user', organizationId: 1, bowlerId: 42 };

function dbResult(rows: unknown[]) {
  const query = {
    from: () => query,
    innerJoin: () => query,
    where: () => query,
    orderBy: () => query,
    limit: () => Promise.resolve(rows),
    then: (resolve: (value: unknown[]) => unknown, reject?: (error: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject),
  };
  return query;
}

function get(path: string, user: object) {
  return fetch(`${baseUrl}${path}`, { headers: { 'x-test-user': JSON.stringify(user) } });
}
function post(path: string, body: unknown, user: object) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-user': JSON.stringify(user) },
    body: JSON.stringify(body),
  });
}

describe('GET /payments/:id/receipt (Task #503)', () => {
  it('returns cached receiptUrl without calling the provider', async () => {
    mockStorage.getPaymentById.mockResolvedValue({
      id: 5, leagueId: 11, providerPaymentId: 'sq_1',
      receiptUrl: 'https://cached/receipt', receiptNumber: 'N-1',
    });

    const res = await get('/api/payments-provider/payments/5/receipt', BOWLER);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.receiptUrl).toBe('https://cached/receipt');
    expect(body.data).toMatchObject({ contractVersion: 'payment-receipt/1', availability: 'available', deliveryEvidence: 'delivery_not_recorded' });
    expect(mockProvider.getPayment).not.toHaveBeenCalled();
    expect(mockStorage.updatePayment).not.toHaveBeenCalled();
  });

  it('gives the initiating payer the shared receipt but partner children only scoped evidence', async () => {
    const payment = {
      id: 15, leagueId: 11, bowlerId: 43, paidByUserId: 100, paymentOperationId: 'op-shared',
      amount: 2000, status: 'paid', providerPaymentId: 'sq_shared',
      receiptUrl: 'https://cached/shared', receiptNumber: 'N-shared',
    };
    mockStorage.getPaymentByIdForOrganization.mockResolvedValue(payment);
    mockStorage.getPaymentById.mockResolvedValue(payment);
    mockStorage.getPaymentsByPaymentOperationId.mockResolvedValue([payment]);
    const makeQueryResults = () => [
      [{ organizationId: 1 }],
      [{ id: 'alloc-1', obligationId: 'ob-1', occurrenceId: 'occ-1', bowlerId: 43, amountMinor: 2000, currency: 'USD', state: 'active' }],
      [{ id: 'op-shared', leagueId: 11, status: 'succeeded' }],
      [],
      [],
      [],
    ];
    const payerQueryResults = makeQueryResults();
    mockDb.select.mockImplementation(() => dbResult(payerQueryResults.shift() ?? []));

    const payerResponse = await get('/api/payments-provider/payments/15/receipt', PAYER);
    expect(payerResponse.status).toBe(200);
    expect((await payerResponse.json()).data).toMatchObject({ receiptUrl: 'https://cached/shared', receiptNumber: 'N-shared' });

    const partnerQueryResults = makeQueryResults();
    mockDb.select.mockImplementation(() => dbResult(partnerQueryResults.shift() ?? []));
    const partnerResponse = await get('/api/payments-provider/payments/15/receipt', PARTNER);
    expect(partnerResponse.status).toBe(200);
    const partnerBody = await partnerResponse.json();
    expect(partnerBody.data).toMatchObject({ receiptUrl: null, receiptNumber: null, paymentOperationId: null });
    expect(partnerBody.data.allocations).toEqual([expect.objectContaining({ bowlerId: 43, amountMinor: 2000 })]);
    expect(mockProvider.getPayment).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'scheduled nullable league', operationType: 'scheduled', operationLeagueId: null },
    { label: 'interactive exact league', operationType: 'interactive', operationLeagueId: 11 },
  ])('applies payer/partner receipt privacy to $label legacy evidence', async ({ operationType, operationLeagueId }) => {
    const payment = {
      id: 16, leagueId: 11, bowlerId: 43, paidByUserId: 100, paymentOperationId: `legacy-${operationType}`,
      amount: 2000, status: 'paid', providerPaymentId: 'sq_legacy', receiptUrl: 'https://cached/legacy', receiptNumber: 'N-legacy',
    };
    mockStorage.getPaymentByIdForOrganization.mockResolvedValue(payment);
    mockStorage.getPaymentsByPaymentOperationId.mockResolvedValue([payment]);
    const legacyRows = [[{ leagueId: 11, paidByUserId: 100, bowlerId: 43, amountMinor: 2000, allocationIndex: 0 }]];
    const makeQueryResults = () => [
      [{ organizationId: 1 }], [],
      [{ id: payment.paymentOperationId, leagueId: operationLeagueId, status: 'succeeded', currency: 'USD', amountMinor: 2000 }],
      ...(operationType === 'scheduled' ? [legacyRows[0]] : [[]]),
      ...(operationType === 'scheduled' ? [] : [legacyRows[0]]),
      [],
    ];
    const payerQueryResults = makeQueryResults();
    mockDb.select.mockImplementation(() => dbResult(payerQueryResults.shift() ?? []));
    const payerResponse = await get('/api/payments-provider/payments/16/receipt', PAYER);
    expect(payerResponse.status).toBe(200);
    expect((await payerResponse.json()).data).toMatchObject({ receiptUrl: 'https://cached/legacy', amountMinor: 2000, sharedTransaction: { childCount: 1 } });

    const partnerQueryResults = makeQueryResults();
    mockDb.select.mockImplementation(() => dbResult(partnerQueryResults.shift() ?? []));
    const partnerResponse = await get('/api/payments-provider/payments/16/receipt', PARTNER);
    expect(partnerResponse.status).toBe(200);
    const partnerBody = await partnerResponse.json();
    expect(partnerBody.data).toMatchObject({ receiptUrl: null, receiptNumber: null, paymentOperationId: null, amountMinor: 2000, sharedTransaction: null });
    expect(partnerBody.data.allocations).toEqual([expect.objectContaining({ bowlerId: 43, amountMinor: 2000, source: 'unlinked_legacy' })]);
  });

  it('fails closed on a cross-league operation instead of resolving a raw cached receipt', async () => {
    const payment = { id: 17, leagueId: 11, bowlerId: 43, paymentOperationId: 'cross-league-op', amount: 2000, status: 'paid', providerPaymentId: 'sq-cross', receiptUrl: 'https://cached/cross', receiptNumber: 'N-cross' };
    mockStorage.getPaymentByIdForOrganization.mockResolvedValue(payment);
    const queryResults = [
      [{ organizationId: 1 }], [],
      [{ id: 'cross-league-op', leagueId: 99, status: 'succeeded', currency: 'USD', amountMinor: 2000 }], [], [], [],
    ];
    mockDb.select.mockImplementation(() => dbResult(queryResults.shift() ?? []));
    const response = await get('/api/payments-provider/payments/17/receipt', ADMIN);
    expect(response.status).toBe(404);
    expect(mockProvider.getPayment).not.toHaveBeenCalled();
  });

  it('lazy-backfills from provider and caches the URL when none is stored yet', async () => {
    mockStorage.getPaymentById.mockResolvedValue({
      id: 6, leagueId: 11, providerPaymentId: 'sq_2',
      receiptUrl: null, receiptNumber: null,
    });
    mockProvider.getPayment.mockResolvedValue({
      id: 'sq_2', status: 'COMPLETED',
      receiptUrl: 'https://squareup.com/receipt/preview/sq_2',
      receiptNumber: 'N-2',
    });

    const res = await get('/api/payments-provider/payments/6/receipt', BOWLER);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.receiptUrl).toBe('https://squareup.com/receipt/preview/sq_2');
    expect(mockProvider.getPayment).toHaveBeenCalledWith('sq_2');
    expect(mockStorage.updatePayment).toHaveBeenCalledWith(6, {
      receiptUrl: 'https://squareup.com/receipt/preview/sq_2',
      receiptNumber: 'N-2',
    });
  });

  it('returns 404 RECEIPT_UNAVAILABLE for cash/check rows without a providerPaymentId', async () => {
    mockStorage.getPaymentById.mockResolvedValue({
      id: 7, leagueId: 11, providerPaymentId: null, receiptUrl: null, receiptNumber: null,
    });

    const res = await get('/api/payments-provider/payments/7/receipt', BOWLER);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error?.code).toBe('RECEIPT_UNAVAILABLE');
  });

  it('returns 403 when the caller has no access to the payment (cross-org)', async () => {
    mockHasAccessToPayment.mockResolvedValue(false);

    const res = await get('/api/payments-provider/payments/5/receipt', BOWLER);
    expect(res.status).toBe(403);
    expect(mockStorage.getPaymentById).not.toHaveBeenCalled();
  });
});

describe('POST /payments/:id/resend-receipt (Task #503)', () => {
  it('rejects non-admin callers with 403 even when they own the payment', async () => {
    const res = await post(
      '/api/payments-provider/payments/5/resend-receipt',
      { email: 'pat@example.com' },
      BOWLER,
    );
    expect(res.status).toBe(403);
    expect(mockSendReceiptResend).not.toHaveBeenCalled();
  });

  it('returns 400 when the email body is invalid', async () => {
    const res = await post(
      '/api/payments-provider/payments/5/resend-receipt',
      { email: 'not-an-email' },
      ADMIN,
    );
    expect(res.status).toBe(400);
    expect(mockSendReceiptResend).not.toHaveBeenCalled();
  });

  it('sends the templated email with resolved receipt + payment metadata on the happy path', async () => {
    mockStorage.getPaymentById.mockResolvedValue({
      id: 5, leagueId: 11, bowlerId: 42, amount: 2500, providerPaymentId: 'sq_1',
      receiptUrl: 'https://cached/receipt', receiptNumber: 'N-1',
    });

    const res = await post(
      '/api/payments-provider/payments/5/resend-receipt',
      { email: 'admin-pick@example.com' },
      ADMIN,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data?.sent).toBe(true);
    expect(mockSendReceiptResend).toHaveBeenCalledWith('admin-pick@example.com', {
      receiptUrl: 'https://cached/receipt',
      receiptNumber: 'N-1',
      amountCents: 2500,
      leagueName: 'Wed Night',
      organizationName: 'Cosmic Lanes',
    });
  });

  // Task #503 (3rd-pass review): admin can omit `email` and the route
  // defaults to the bowler's on-file email.
  it('defaults to the bowler.email when no email is supplied in the body', async () => {
    mockStorage.getPaymentById.mockResolvedValue({
      id: 5, leagueId: 11, bowlerId: 42, amount: 2500, providerPaymentId: 'sq_1',
      receiptUrl: 'https://cached/receipt', receiptNumber: 'N-1',
    });
    mockStorage.getBowler.mockResolvedValue({
      id: 42, name: 'Pat', email: 'on-file@example.com',
    });

    const res = await post(
      '/api/payments-provider/payments/5/resend-receipt',
      {},
      ADMIN,
    );
    expect(res.status).toBe(200);
    expect(mockSendReceiptResend).toHaveBeenCalledWith('on-file@example.com', expect.any(Object));
  });

  it('returns 400 NO_TARGET_EMAIL when neither override nor bowler email is available', async () => {
    mockStorage.getPaymentById.mockResolvedValue({
      id: 5, leagueId: 11, bowlerId: 42, amount: 2500, providerPaymentId: 'sq_1',
      receiptUrl: 'https://cached/receipt', receiptNumber: 'N-1',
    });
    mockStorage.getBowler.mockResolvedValue({ id: 42, name: 'Pat', email: null });

    const res = await post(
      '/api/payments-provider/payments/5/resend-receipt',
      {},
      ADMIN,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error?.code).toBe('NO_TARGET_EMAIL');
    expect(mockSendReceiptResend).not.toHaveBeenCalled();
  });
});
