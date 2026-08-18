import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type Request } from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const { mockStorage, mockHasAccessToLeague, mockHasAccessToBowler, mockIsOrgOrHigher, mockCanUserPay, mockActivation, mockQuote } = vi.hoisted(() => ({
  mockStorage: { getLeague: vi.fn(), getGeneralInteractivePaymentOperationForOrganization: vi.fn() },
  mockHasAccessToLeague: vi.fn(),
  mockHasAccessToBowler: vi.fn(),
  mockIsOrgOrHigher: vi.fn(),
  mockCanUserPay: vi.fn(),
  mockActivation: vi.fn(),
  mockQuote: vi.fn(),
}));

vi.mock('../../server/storage', () => ({ storage: mockStorage }));
vi.mock('../../server/utils/access-control', () => ({
  hasAccessToLeague: (...args: unknown[]) => mockHasAccessToLeague(...args),
  hasAccessToBowler: (...args: unknown[]) => mockHasAccessToBowler(...args),
  isOrgOrHigher: (...args: unknown[]) => mockIsOrgOrHigher(...args),
  hasAccessToPayment: vi.fn(),
}));
vi.mock('../../server/utils/bowler-payment-authz', () => ({ canUserPayForBowler: (...args: unknown[]) => mockCanUserPay(...args) }));
vi.mock('../../server/middleware/rate-limit', () => ({ paymentLimiter: (_req: unknown, _res: unknown, next: () => void) => next() }));
vi.mock('../../server/services/interactive-occurrence-allocation', async () => {
  class TestInteractiveOccurrenceAllocationError extends Error {
    code: string;
    constructor(code: string) { super(code); this.code = code; }
  }
  return {
    InteractiveOccurrenceAllocationError: TestInteractiveOccurrenceAllocationError,
    getInteractiveOccurrenceActivation: (...args: unknown[]) => mockActivation(...args),
    quoteInteractiveOccurrenceAllocations: (...args: unknown[]) => mockQuote(...args),
    validateInteractiveOccurrenceBaseAllocations: vi.fn(),
  };
});
vi.mock('../../server/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }), logger: {} }));

const chargesRouter = (await import('../../server/routes/payments-provider/charges')).default;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const raw = req.header('x-test-user');
    if (raw) (req as Request & { user?: unknown }).user = JSON.parse(raw);
    const scope = req.header('x-test-org');
    if (scope) (req as Request & { organizationFilter?: number }).organizationFilter = Number(scope);
    next();
  });
  app.use('/api/payments-provider', chargesRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

beforeEach(() => {
  for (const fn of Object.values(mockStorage)) fn.mockReset();
  mockHasAccessToLeague.mockReset(); mockHasAccessToBowler.mockReset(); mockIsOrgOrHigher.mockReset();
  mockCanUserPay.mockReset(); mockActivation.mockReset(); mockQuote.mockReset();
  mockStorage.getLeague.mockResolvedValue({ id: 11, organizationId: 1 });
  mockStorage.getGeneralInteractivePaymentOperationForOrganization.mockResolvedValue(undefined);
  mockHasAccessToLeague.mockResolvedValue(true); mockHasAccessToBowler.mockResolvedValue(true);
  mockIsOrgOrHigher.mockReturnValue(false); mockCanUserPay.mockResolvedValue({ allowed: true, payerBowlerId: 7 });
  mockActivation.mockResolvedValue(true);
  mockQuote.mockImplementation(async ({ organizationId, leagueId, amountMinor, currency, allowedBowlerIds }: { organizationId: number; leagueId: number; amountMinor: number; currency: string; allowedBowlerIds: number[] }) => ({
    contractVersion: 'interactive-obligation-quote/1', orderVersion: 'due-at,bowler,occurrence,obligation/1', organizationId, leagueId, currency, amountMinor,
    activationId: 'activation-1', activationSourceFingerprint: 'source-1',
    rows: allowedBowlerIds.map((bowlerId, index) => ({ obligationId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, occurrenceId: `occ-${bowlerId}`, bowlerId, amountMinor, allocatedMinor: 0, outstandingMinor: amountMinor, currency, dueAt: null })),
    selections: [], fingerprint: 'lvpayquote:v1:' + 'e'.repeat(64),
  }));
});

async function quote(user: Record<string, unknown>, body: Record<string, unknown>, orgHeader?: string, combined = false) {
  return fetch(`${baseUrl}/api/payments-provider/${combined ? 'combined-payments' : 'payments'}/quote`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-test-user': JSON.stringify(user), ...(orgHeader ? { 'x-test-org': orgHeader } : {}) }, body: JSON.stringify(body),
  });
}

describe('interactive quote tenant and actor visibility', () => {
  it('allows self and accepted partner rows but does not broaden an ordinary member quote', async () => {
    const user = { id: 1, role: 'bowler', organizationId: 1, bowlerId: 7 };
    const self = await quote(user, { leagueId: 11, amountMinor: 2000, bowlerId: 7 });
    expect(self.status).toBe(200);
    expect((await self.json()).rows.map((row: { bowlerId: number }) => row.bowlerId)).toEqual([7]);
    const partner = await quote(user, { leagueId: 11, amountMinor: 2000, bowlerId: 8 });
    expect(partner.status).toBe(200);
    expect((await partner.json()).rows.map((row: { bowlerId: number }) => row.bowlerId)).toEqual([8]);
    mockCanUserPay.mockResolvedValue({ allowed: false });
    const unrelated = await quote({ id: 9, role: 'bowler', organizationId: 1, bowlerId: 9 }, { leagueId: 11, amountMinor: 2000, bowlerId: 8 });
    expect(unrelated.status).toBe(404);
  });

  it('allows tenant-scoped org admins and explicitly scoped system admins only', async () => {
    mockIsOrgOrHigher.mockReturnValue(true);
    const admin = await quote({ id: 2, role: 'org_admin', organizationId: 1 }, { leagueId: 11, amountMinor: 4000, payees: [{ bowlerId: 7 }, { bowlerId: 8 }] });
    expect(admin.status).toBe(200);
    expect((await admin.json()).rows.map((row: { bowlerId: number }) => row.bowlerId)).toEqual([7, 8]);
    mockIsOrgOrHigher.mockReturnValue(false);
    const unscopedSystem = await quote({ id: 3, role: 'system_admin', organizationId: null }, { leagueId: 11, organizationId: 1, amountMinor: 2000, bowlerId: 7 });
    expect(unscopedSystem.status).toBe(200);
  });

  it('fails closed without disclosing a foreign tenant league for single and combined quotes', async () => {
    mockStorage.getLeague.mockResolvedValue({ id: 11, organizationId: 2 });
    const response = await quote({ id: 3, role: 'system_admin', organizationId: null }, { leagueId: 11, organizationId: 1, amountMinor: 2000, bowlerId: 7 });
    expect(response.status).toBe(404);
    const combined = await quote({ id: 3, role: 'system_admin', organizationId: null }, { leagueId: 11, organizationId: 1, amountMinor: 4000, payees: [{ bowlerId: 7 }, { bowlerId: 8 }] }, undefined, true);
    expect(combined.status).toBe(404);
    expect(mockActivation).not.toHaveBeenCalled();
    expect(mockQuote).not.toHaveBeenCalled();
  });

  it('lets an explicitly scoped org-less system admin recover a stored-key operation without a new quote', async () => {
    const requestKey = 'recovery-key-123456';
    mockStorage.getGeneralInteractivePaymentOperationForOrganization.mockResolvedValue({
      id: 'operation-1', organizationId: 1, targetKey: `interactive-charge:${requestKey}`,
      status: 'pending', attemptCount: 0, nextAttemptAt: new Date(Date.now() + 60_000),
      providerObjectId: null, providerOrderId: null, authorizingUserId: 3,
    });
    const response = await fetch(`${baseUrl}/api/payments-provider/payment-operations/status?organizationId=1`, {
      headers: { 'Idempotency-Key': requestKey, 'x-test-user': JSON.stringify({ id: 3, role: 'system_admin', organizationId: null }) },
    });
    expect(response.status).toBe(202);
    expect(mockActivation).not.toHaveBeenCalled();
    expect(mockQuote).not.toHaveBeenCalled();
  });

  it('does not let an unrelated same-org user recover an immutable actor operation', async () => {
    const requestKey = 'recovery-key-123456';
    mockStorage.getGeneralInteractivePaymentOperationForOrganization.mockResolvedValue({
      id: 'operation-1', organizationId: 1, targetKey: `interactive-charge:${requestKey}`,
      status: 'pending', attemptCount: 0, nextAttemptAt: new Date(Date.now() + 60_000),
      providerObjectId: null, providerOrderId: null, authorizingUserId: 3,
    });
    const response = await fetch(`${baseUrl}/api/payments-provider/payment-operations/status`, {
      headers: { 'Idempotency-Key': requestKey, 'x-test-user': JSON.stringify({ id: 4, role: 'bowler', organizationId: 1, bowlerId: 7 }) },
    });
    expect(response.status).toBe(404);
  });
});
