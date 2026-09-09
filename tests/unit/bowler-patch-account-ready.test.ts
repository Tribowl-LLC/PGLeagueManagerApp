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

vi.mock('../../server/services/payment-provider-factory', () => ({
  getPaymentProvider: vi.fn(),
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
});
