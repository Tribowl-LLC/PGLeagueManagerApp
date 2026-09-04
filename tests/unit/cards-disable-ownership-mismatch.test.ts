/**
 * Task #620 — Replace fragile string-match for the "card does not
 * belong" guard with a typed error.
 *
 * The DELETE `/api/payments-provider/cards/:bowlerId/:cardId` route
 * has a dedicated 403 branch for the tenancy-violation case where a
 * caller tries to remove a card id that isn't on this customer's
 * vault. Pre-#620 the route detected that case with
 * `error.constructor === Error` + a substring check on
 * `error.message`. That worked but was fragile in two ways:
 *
 *   1. Any other plain `Error` thrown anywhere in the provider chain
 *      (e.g. a future call-site forgetting to wrap a low-level
 *      failure in `PaymentProviderError`) would still satisfy the
 *      `constructor === Error` check, and if its message happened
 *      to contain the substring "does not belong" it would have
 *      mapped to the same 403 + leaked the unsanitized message
 *      verbatim — instead of routing through the shared
 *      `buildPaymentErrorResponse` fallback (500 + the route's
 *      sanitized "Failed to remove card" sentence).
 *   2. A future refactor wrapping the throw in any subclass would
 *      silently flip the branch off (because `constructor === Error`
 *      is strict-equality, not an `instanceof` check) and the
 *      tenancy violation would leak as a generic 500.
 *
 * Task #620 introduced a typed `CardOwnershipMismatchError` (in
 * `server/services/payment-provider-factory.ts`) and switched the
 * route to match on `instanceof`. These tests pin both directions of
 * the new contract:
 *
 *   - `CardOwnershipMismatchError` thrown by `provider.disableCard`
 *     still maps to 403 with the typed message (the legitimate
 *     tenancy-violation path that pre-#620 callers depended on).
 *   - An unrelated plain `Error` thrown by `provider.disableCard`
 *     (even one whose message contains the literal substring "does
 *     not belong") now falls through to the shared helper's 500 +
 *     "Failed to remove card" + `REMOVE_CARD_ERROR` envelope, NEVER
 *     to the 403 branch. This is the regression the typed class
 *     prevents.
 */
import {
  afterAll, afterEach, beforeAll, beforeEach,
  describe, expect, it, vi,
} from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const mockStorage = {
  getBowler: vi.fn(),
  getBowlerLeagues: vi.fn(),
};
vi.mock('../../server/storage', () => ({ storage: mockStorage }));

const mockHasSelfOrAdminAccessToBowler = vi.fn();
vi.mock('../../server/utils/access-control', () => ({
  hasSelfOrAdminAccessToBowler: (...a: unknown[]) => mockHasSelfOrAdminAccessToBowler(...a),
}));

const mockProvider = {
  providerName: 'square' as const,
  locationId: 99,
  disableCard: vi.fn(),
};
const mockGetPaymentProvider = vi.fn();
const mockGetProviderForLeague = vi.fn();

vi.mock('../../server/routes/payments-provider/shared', () => ({
  getProviderForLeague: (...a: unknown[]) => mockGetProviderForLeague(...a),
}));

// Mock payment-utils so the route resolves a customer id from the
// stub bowler row without needing the real Square lookup.
vi.mock('../../server/services/payment-utils', () => ({
  getProviderCustomerId: (bowler: { squareCustomerId?: string }) =>
    bowler.squareCustomerId ?? null,
  ensureProviderCustomer: vi.fn(),
}));

// eslint-disable-next-line local/factory-must-use-schema -- mocked logger, not a schema row
const fakeLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  captureException: vi.fn(),
  debug: vi.fn(),
};
vi.mock('../../server/logger', () => ({ logger: fakeLogger, createLogger: () => fakeLogger }));

// Use the real payment-provider-factory exports — the whole point of
// this test is that the route matches on the real
// `CardOwnershipMismatchError` class via `instanceof`. We only
// substitute `getPaymentProvider` so the route resolves to our stub
// provider instead of trying to load a real location row.
vi.mock('../../server/services/payment-provider-factory', async () => {
  const actual = await vi.importActual<
    typeof import('../../server/services/payment-provider-factory')
  >('../../server/services/payment-provider-factory');
  return {
    ...actual,
    getPaymentProvider: (...a: unknown[]) => mockGetPaymentProvider(...a),
  };
});

const cardsRouter = (await import('../../server/routes/payments-provider/cards')).default;
const { CardOwnershipMismatchError } = await import(
  '../../server/services/payment-provider-factory'
);

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/payments-provider', cardsRouter);
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
  mockHasSelfOrAdminAccessToBowler.mockReset();
  mockGetPaymentProvider.mockReset();
  mockGetProviderForLeague.mockReset();
  mockProvider.disableCard.mockReset();

  mockHasSelfOrAdminAccessToBowler.mockResolvedValue(true);
  mockStorage.getBowler.mockResolvedValue({
    id: 42, name: 'Pat', email: 'pat@example.com', squareCustomerId: 'sq_cust_1',
  });
  mockStorage.getBowlerLeagues.mockResolvedValue([]);
  // Bowler has no league → DELETE route falls through to the
  // location-less getPaymentProvider(null) branch. Both branches
  // resolve to the same stub provider here.
  mockGetPaymentProvider.mockResolvedValue(mockProvider);
  mockGetProviderForLeague.mockResolvedValue(mockProvider);
});

afterEach(() => vi.clearAllMocks());

async function deleteCard(cardId: string) {
  return fetch(
    `${baseUrl}/api/payments-provider/cards/42/${encodeURIComponent(cardId)}`,
    { method: 'DELETE' },
  );
}

describe('DELETE /cards/:bowlerId/:cardId — typed ownership-mismatch guard (Task #620)', () => {
  it('maps CardOwnershipMismatchError to 403 with the typed message', async () => {
    // Sanity check on the legitimate tenancy-violation path: the
    // typed error coming out of provider.disableCard MUST still
    // produce the dedicated 403 the route reserves for "card id is
    // not on this customer's vault".
    mockProvider.disableCard.mockRejectedValue(new CardOwnershipMismatchError());

    const res = await deleteCard('card-from-someone-else');

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.message).toBe('Card does not belong to this customer');
    expect(fakeLogger.captureException).not.toHaveBeenCalled();
  });

  it('does NOT map an unrelated plain Error to 403, even when its message contains "does not belong"', async () => {
    // The whole point of the typed class: a plain `Error` whose
    // message accidentally matches the old substring guard MUST
    // fall through to the shared helper's fallback envelope (500 +
    // "Failed to remove card" + REMOVE_CARD_ERROR), never to the
    // 403 branch. Pre-#620 this would have leaked the raw provider
    // message verbatim with a 403 status, mis-signaling to admins
    // that the caller had a tenancy-violation bug instead of a
    // generic provider failure.
    mockProvider.disableCard.mockRejectedValue(
      new Error('downstream cache row does not belong to current shard'),
    );

    const res = await deleteCard('card-real');

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('REMOVE_CARD_ERROR');
    expect(body.error.message).toBe('Failed to remove card');
    // Pin the negative: the raw provider message must NOT leak to
    // the client envelope through the fallback branch.
    expect(body.error.message).not.toContain('does not belong');
    expect(body.error.message).not.toContain('downstream cache');
    expect(fakeLogger.captureException).toHaveBeenCalledOnce();
  });

  it('does NOT map a generic plain Error to 403 either', async () => {
    // Symmetric pin for the more common case — a plain Error with
    // an unrelated message must also fall through to the 500
    // fallback. This catches a future regression where someone
    // accidentally re-broadens the guard back to
    // `error instanceof Error` without the typed-class check.
    mockProvider.disableCard.mockRejectedValue(new Error('upstream timeout'));

    const res = await deleteCard('card-real');

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('REMOVE_CARD_ERROR');
    expect(body.error.message).toBe('Failed to remove card');
    expect(fakeLogger.captureException).toHaveBeenCalledOnce();
  });
});
