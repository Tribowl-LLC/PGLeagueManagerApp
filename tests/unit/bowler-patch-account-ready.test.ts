/**
 * PATCH /api/bowlers/:id account-ready transition coverage.
 *
 * A profile email update may create the first ordinary-user → bowler link.
 * The identity service owns the locked uniqueness proof; this route owns the
 * post-commit notification and must keep the profile PATCH best-effort when
 * email delivery is unavailable.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const mocks = vi.hoisted(() => ({
  getBowler: vi.fn(),
  updateBowler: vi.fn(),
  getUserByEmail: vi.fn(),
  getOrganization: vi.fn(),
  getFirstSquareConfiguredLocation: vi.fn(),
  getPaymentProvider: vi.fn(),
  linkUserToBowler: vi.fn(),
  sendAccountReadyEmail: vi.fn(),
}));

vi.mock('../../server/storage', () => ({
  storage: {
    getBowler: mocks.getBowler,
    updateBowler: mocks.updateBowler,
    getUserByEmail: mocks.getUserByEmail,
    getOrganization: mocks.getOrganization,
    getFirstSquareConfiguredLocation: mocks.getFirstSquareConfiguredLocation,
  },
}));

vi.mock('../../server/services/identity-link', () => ({
  linkUserToBowler: mocks.linkUserToBowler,
}));

vi.mock('../../server/services/email', () => ({
  sendAccountReadyEmail: mocks.sendAccountReadyEmail,
}));

vi.mock('../../server/services/bowler-sync', () => ({
  runBowlerPostCreateSync: vi.fn(async (bowler: unknown) => bowler),
}));

vi.mock('../../server/services/bowler-attributes', () => ({
  syncBowlerLeagueAttributesToProvider: vi.fn(async () => ({ ok: true })),
}));

vi.mock('../../server/services/payment-sync-retry-scheduler', () => ({
  notifyPaymentSyncRetryChanged: vi.fn(),
}));

// The PATCH route imports the deletion error types alongside its DELETE
// handler. Keep this unit suite's route graph in-process; deletion itself is
// covered by the database-backed/API suites.
vi.mock('../../server/services/bowler-deletion.js', () => ({
  BowlerDeletionConflictError: class BowlerDeletionConflictError extends Error {
    readonly status = 409;
    readonly blockers = [{ code: 'TEST', message: 'test blocker' }];

    constructor() {
      super('Bowler deletion blocked');
      this.name = 'BowlerDeletionConflictError';
    }
  },
  BowlerDeletionNotFoundError: class BowlerDeletionNotFoundError extends Error {
    readonly status = 404;

    constructor() {
      super('Bowler not found');
      this.name = 'BowlerDeletionNotFoundError';
    }
  },
  deleteUnusedBowler: vi.fn(),
}));

vi.mock('../../server/services/payment-provider-factory', () => ({
  getPaymentProvider: mocks.getPaymentProvider,
  ProviderNotConfiguredError: class ProviderNotConfiguredError extends Error {},
}));

vi.mock('../../server/routes/payments/payment-reports.js', () => ({
  buildPayerNameMap: vi.fn(async () => new Map()),
}));

vi.mock('../../server/middleware/rate-limit', () => ({
  bowlerSearchLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../../server/utils/bowler-payment-authz', () => ({
  canUserPayForBowler: vi.fn(async () => ({ allowed: false })),
}));

vi.mock('../../server/config', () => ({
  isDev: false,
}));

vi.mock('../../server/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../server/utils/access-control', () => ({
  getPaymentManagerAccessibleBowlerIds: vi.fn(async () => []),
  getPaymentManagerAccessibleLeagueIds: vi.fn(async () => []),
  hasAccessToTeam: vi.fn(async () => true),
  hasAccessToBowler: vi.fn(async () => true),
  hasAccessToBowlers: vi.fn(async () => new Map()),
  hasPaymentManagerAccessToBowler: vi.fn(async () => true),
  hasSelfOrAdminAccessToBowler: vi.fn(async () => true),
  isOrgOrHigher: vi.fn(() => true),
  isPaymentManager: vi.fn(() => false),
}));

const bowlersRouter = (await import('../../server/routes/bowlers')).default;

const ACTING_ADMIN = {
  id: 900,
  email: 'admin@tenant.test',
  name: 'Tenant Admin',
  role: 'org_admin' as const,
  organizationId: 42,
};

const ORIGINAL_BOWLER = {
  id: 7,
  name: 'Alex Bowler',
  email: null,
  phone: null,
  active: true,
  order: 0,
  organizationId: 42,
  paymentCustomerId: null,
  paymentProviderLocationId: null,
  paymentSyncPendingAt: null,
  paymentSyncAttempts: 0,
  paymentSyncLastAttemptAt: null,
  paymentSyncNextRetryAt: null,
};

const UPDATED_BOWLER = {
  ...ORIGINAL_BOWLER,
  email: 'alex@example.test',
};

const LINKED_USER = {
  id: 12,
  email: 'alex@example.test',
  name: 'Alex Account',
  role: 'user' as const,
  organizationId: 42,
  bowlerId: 7,
};

const ORGANIZATION = {
  id: 42,
  name: 'Tenant 42',
  slug: 'internal-tenant-42',
  subdomain: 'tenant-42',
  logo: null,
};

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.defineProperty(req, 'user', { value: ACTING_ADMIN, configurable: true });
    next();
  });
  app.use('/api/bowlers', bowlersRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.getBowler.mockResolvedValue({ ...ORIGINAL_BOWLER });
  mocks.updateBowler.mockResolvedValue({ ...UPDATED_BOWLER });
  mocks.getUserByEmail.mockResolvedValue({
    id: LINKED_USER.id,
    email: LINKED_USER.email,
    name: LINKED_USER.name,
    role: LINKED_USER.role,
    organizationId: LINKED_USER.organizationId,
    bowlerId: null,
  });
  mocks.getOrganization.mockResolvedValue({ ...ORGANIZATION });
  mocks.getFirstSquareConfiguredLocation.mockResolvedValue(null);
  mocks.linkUserToBowler.mockResolvedValue({
    user: { ...LINKED_USER },
    bowler: { ...UPDATED_BOWLER },
    oldBowler: null,
    event: null,
  });
  mocks.sendAccountReadyEmail.mockResolvedValue('accepted');
});

async function patchEmail() {
  return fetch(`${baseUrl}/api/bowlers/${ORIGINAL_BOWLER.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: UPDATED_BOWLER.email }),
  });
}

describe('PATCH /api/bowlers/:id account-ready auto-link', () => {
  it('uses locked email proof and sends one notification after a committed link', async () => {
    const response = await patchEmail();

    expect(response.status).toBe(200);
    expect(mocks.linkUserToBowler).toHaveBeenCalledTimes(1);
    expect(mocks.linkUserToBowler).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: ORIGINAL_BOWLER.organizationId,
      userId: LINKED_USER.id,
      bowlerId: ORIGINAL_BOWLER.id,
      requireEmailMatch: true,
    }));
    expect(mocks.getOrganization).toHaveBeenCalledWith(ORIGINAL_BOWLER.organizationId);
    expect(mocks.sendAccountReadyEmail).toHaveBeenCalledTimes(1);
    expect(mocks.sendAccountReadyEmail).toHaveBeenCalledWith({
      toEmail: LINKED_USER.email,
      toName: LINKED_USER.name,
      bowlerName: UPDATED_BOWLER.name,
      organization: ORGANIZATION,
    });
  });

  it.each([
    ['duplicate same-email profiles', 'ambiguous email'],
    ['a normalized email mismatch', 'email mismatch'],
  ])('does not notify when the locked identity proof rejects %s', async (_caseName, message) => {
    mocks.linkUserToBowler.mockRejectedValueOnce(new Error(message));

    const response = await patchEmail();

    expect(response.status).toBe(200);
    expect(mocks.linkUserToBowler).toHaveBeenCalledTimes(1);
    expect(mocks.sendAccountReadyEmail).not.toHaveBeenCalled();
    expect(mocks.getOrganization).not.toHaveBeenCalled();
  });

  it('keeps the PATCH successful when account-ready email fails', async () => {
    mocks.sendAccountReadyEmail.mockRejectedValueOnce(new Error('provider unavailable'));

    const response = await patchEmail();

    expect(response.status).toBe(200);
    expect(mocks.linkUserToBowler).toHaveBeenCalledTimes(1);
    expect(mocks.sendAccountReadyEmail).toHaveBeenCalledTimes(1);
  });

  it('carries the identity-link backfilled phone to the provider, the response, and the customer-id write', async () => {
    const FRESH_PHONE = '+1-202-555-0142';
    const linkedBowler = {
      ...UPDATED_BOWLER,
      phone: FRESH_PHONE,
      // No payment-sync queue: the identity-link backfilled the phone
      // without queueing provider work, so the route still performs the
      // foreground sync and carries the fresh row through to the provider
      // and the customer-id write.
      paymentSyncPendingAt: null,
      paymentSyncAttempts: 0,
      paymentSyncLastAttemptAt: null,
      paymentSyncNextRetryAt: null,
    };
    const squareLocation = { id: 321 };
    const createOrUpdateCustomer = vi.fn(async () => ({ id: 'sq_test_customer_1' }));
    mocks.linkUserToBowler.mockResolvedValue({
      user: { ...LINKED_USER },
      bowler: linkedBowler,
      oldBowler: null,
      event: null,
    });
    mocks.getFirstSquareConfiguredLocation.mockResolvedValue(squareLocation);
    mocks.getPaymentProvider.mockResolvedValue({ createOrUpdateCustomer });
    // Model row updates like production: the persisted row carries what the
    // route wrote, so the customer-id write returns the fresh contact details.
    mocks.updateBowler.mockResolvedValueOnce({ ...UPDATED_BOWLER });
    mocks.updateBowler.mockResolvedValueOnce({
      ...linkedBowler,
      paymentCustomerId: 'sq_test_customer_1',
      paymentProviderLocationId: squareLocation.id,
    });

    const response = await patchEmail();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.linkUserToBowler).toHaveBeenCalledTimes(1);
    // The provider receives the backfilled phone, not the pre-link blank.
    expect(createOrUpdateCustomer).toHaveBeenCalledTimes(1);
    expect(createOrUpdateCustomer).toHaveBeenCalledWith(
      UPDATED_BOWLER.name,
      UPDATED_BOWLER.email,
      FRESH_PHONE,
      `bowler:${ORIGINAL_BOWLER.id}`,
    );
    // The PATCH response reflects the committed linked row.
    expect(body).toEqual({
      success: true,
      data: expect.objectContaining({
        id: ORIGINAL_BOWLER.id,
        email: UPDATED_BOWLER.email,
        phone: FRESH_PHONE,
      }),
    });
    // The follow-up customer-id write spreads the fresh row (phone included)
    // instead of the pre-link snapshot that would erase the backfill.
    expect(mocks.updateBowler).toHaveBeenCalledTimes(2);
    expect(mocks.updateBowler).toHaveBeenLastCalledWith(ORIGINAL_BOWLER.id, {
      ...linkedBowler,
      paymentCustomerId: 'sq_test_customer_1',
      paymentProviderLocationId: squareLocation.id,
    });
  });

  it('leaves the queued provider sync to the durable queue worker after an account link', async () => {
    const FRESH_PHONE = '+1-202-555-0142';
    const QUEUE_PENDING_AT = '2026-09-15T12:00:00.000Z';
    const linkedBowler = {
      ...UPDATED_BOWLER,
      phone: FRESH_PHONE,
      // The identity-link service queued the payment-sync work while both
      // rows were locked; the durable queue worker now owns the provider
      // sync, so the route must not issue a competing foreground call or
      // a queue-clearing follow-up write.
      paymentSyncPendingAt: QUEUE_PENDING_AT,
      paymentSyncAttempts: 0,
      paymentSyncLastAttemptAt: null,
      paymentSyncNextRetryAt: QUEUE_PENDING_AT,
    };
    const squareLocation = { id: 321 };
    const createOrUpdateCustomer = vi.fn(async () => ({ id: 'sq_test_customer_1' }));
    mocks.linkUserToBowler.mockResolvedValue({
      user: { ...LINKED_USER },
      bowler: linkedBowler,
      oldBowler: null,
      event: null,
    });
    mocks.getFirstSquareConfiguredLocation.mockResolvedValue(squareLocation);
    mocks.getPaymentProvider.mockResolvedValue({ createOrUpdateCustomer });

    const response = await patchEmail();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.linkUserToBowler).toHaveBeenCalledTimes(1);
    // The account-ready notification still fires for the committed link.
    expect(mocks.sendAccountReadyEmail).toHaveBeenCalledTimes(1);
    // The queued sync is left to the durable queue worker: no competing
    // foreground provider call.
    expect(mocks.getFirstSquareConfiguredLocation).not.toHaveBeenCalled();
    expect(mocks.getPaymentProvider).not.toHaveBeenCalled();
    expect(createOrUpdateCustomer).not.toHaveBeenCalled();
    // No queue-clearing follow-up write: only the initial updateBowler.
    expect(mocks.updateBowler).toHaveBeenCalledTimes(1);
    // The PATCH response reflects the committed linked row, queue intact.
    expect(body).toEqual({
      success: true,
      data: expect.objectContaining({
        id: ORIGINAL_BOWLER.id,
        email: UPDATED_BOWLER.email,
        phone: FRESH_PHONE,
        paymentSyncPendingAt: QUEUE_PENDING_AT,
        paymentSyncNextRetryAt: QUEUE_PENDING_AT,
      }),
    });
  });
});
