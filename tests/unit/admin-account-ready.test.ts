/**
 * Route-level coverage for the manually selected account-ready resend.
 *
 * The helper/provider itself is covered separately. These tests pin the
 * route's tenant, role, link, recipient, strict-id, and best-effort response
 * boundaries without making a live provider call.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const ACTING_ORG_ADMIN = {
  id: 1001,
  email: 'admin@tenant-a.test',
  name: 'Tenant A Admin',
  role: 'org_admin' as const,
  organizationId: 42,
};

const ACTING_SYSTEM_ADMIN = {
  id: 1002,
  email: 'system@leaguevault.test',
  name: 'System Admin',
  role: 'system_admin' as const,
  organizationId: null,
};

const TARGET_USER = {
  id: 2001,
  email: 'bowler@tenant-a.test',
  name: 'Linked Bowler',
  role: 'user' as const,
  organizationId: 42,
  bowlerId: 77,
};

const TARGET_BOWLER = {
  id: 77,
  name: 'Linked Bowler',
  email: 'bowler@tenant-a.test',
  organizationId: 42,
};

const TARGET_ORGANIZATION = {
  id: 42,
  name: 'Tenant A',
  slug: 'internal-tenant-a',
  subdomain: 'tenant-a',
  logo: null,
};

const mockSendAccountReadyEmail = vi.fn(
  async (): Promise<'accepted' | 'not_sent'> => 'accepted',
);
const mockGetUser = vi.fn();
const mockGetBowler = vi.fn();
const mockGetOrganization = vi.fn();
const mockGetBowlerLeagues = vi.fn(async () => []);
const mockGetLeague = vi.fn(async () => undefined);
const mockGetTeam = vi.fn(async () => undefined);

vi.mock('../../server/services/email', () => ({
  sendAccountReadyEmail: (...args: unknown[]) =>
    mockSendAccountReadyEmail.apply(null, args as never),
  sendInviteEmail: vi.fn(async () => true),
  sendTemplatedEmail: vi.fn(async () => true),
  sendPasswordChangedNotification: vi.fn(async () => true),
  getBaseUrl: vi.fn(() => 'https://test.example'),
  getOrgLogoUrl: vi.fn(() => 'https://test.example/logo.png'),
}));

vi.mock('../../server/storage', () => ({
  storage: {
    getUser: (...args: unknown[]) => mockGetUser.apply(null, args as never),
    getBowler: (...args: unknown[]) => mockGetBowler.apply(null, args as never),
    getOrganization: (...args: unknown[]) => mockGetOrganization.apply(null, args as never),
    getBowlerLeagues: (...args: unknown[]) => mockGetBowlerLeagues.apply(null, args as never),
    getLeague: (...args: unknown[]) => mockGetLeague.apply(null, args as never),
    getTeam: (...args: unknown[]) => mockGetTeam.apply(null, args as never),
  },
}));

vi.mock('../../server/db', () => ({
  db: {
    transaction: vi.fn(),
  },
  pool: {},
}));

vi.mock('../../server/auth', () => ({
  hashPassword: vi.fn(async (password: string) => password),
  destroyOtherSessionsForUser: vi.fn(async () => 0),
}));

vi.mock('../../server/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('express-rate-limit', () => ({
  default: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  ipKeyGenerator: (ip: string) => ip,
}));

const orgAdminRouter = (await import('../../server/routes/organization-admin')).default;

let server: Server;
let baseUrl: string;
let actingUser: typeof ACTING_ORG_ADMIN | typeof ACTING_SYSTEM_ADMIN | null = ACTING_ORG_ADMIN;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.defineProperty(req, 'user', {
      value: actingUser,
      configurable: true,
    });
    Object.defineProperty(req, 'isAuthenticated', {
      value: () => actingUser !== null,
      configurable: true,
    });
    Object.defineProperty(req, 'ip', { value: '198.51.100.42', configurable: true });
    next();
  });
  app.use('/api/organization-admin', orgAdminRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  baseUrl = 'http://127.0.0.1:' + address.port;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

beforeEach(() => {
  actingUser = ACTING_ORG_ADMIN;
  mockGetUser.mockReset();
  mockGetUser.mockResolvedValue({ ...TARGET_USER });
  mockGetBowler.mockReset();
  mockGetBowler.mockResolvedValue({ ...TARGET_BOWLER });
  mockGetOrganization.mockReset();
  mockGetOrganization.mockResolvedValue({ ...TARGET_ORGANIZATION });
  mockGetBowlerLeagues.mockReset();
  mockGetBowlerLeagues.mockResolvedValue([]);
  mockGetLeague.mockReset();
  mockGetLeague.mockResolvedValue(undefined);
  mockGetTeam.mockReset();
  mockGetTeam.mockResolvedValue(undefined);
  mockSendAccountReadyEmail.mockReset();
  mockSendAccountReadyEmail.mockResolvedValue('accepted');
});

async function resend(id: string | number, body: unknown = {}) {
  return fetch(
    baseUrl + '/api/organization-admin/users/' + String(id) + '/resend-account-ready',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
}

describe('POST /api/organization-admin/users/:id/resend-account-ready', () => {
  it('resolves recipient and tenant URL from the linked server rows', async () => {
    const response = await resend(TARGET_USER.id, {
      email: 'attacker@example.test',
      organizationUrl: 'https://attacker.example.test',
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.emailNotification).toBe('accepted');
    expect(mockGetUser).toHaveBeenCalledWith(TARGET_USER.id);
    expect(mockGetBowler).toHaveBeenCalledWith(TARGET_USER.bowlerId);
    expect(mockGetOrganization).toHaveBeenCalledWith(TARGET_USER.organizationId);
    expect(mockSendAccountReadyEmail).toHaveBeenCalledWith({
      toEmail: TARGET_USER.email,
      toName: TARGET_USER.name,
      bowlerName: TARGET_BOWLER.name,
      leagueName: '',
      teamName: '',
      organization: TARGET_ORGANIZATION,
    });
  });

  it('returns not_sent while preserving success when the provider/helper rejects', async () => {
    mockSendAccountReadyEmail.mockResolvedValue('not_sent');

    const response = await resend(TARGET_USER.id);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.emailNotification).toBe('not_sent');
  });

  it('rejects an unlinked ordinary account without dispatching', async () => {
    mockGetUser.mockResolvedValue({ ...TARGET_USER, bowlerId: null });

    const response = await resend(TARGET_USER.id);
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.code).toBe('NOT_LINKED');
    expect(mockSendAccountReadyEmail).not.toHaveBeenCalled();
  });

  it('rejects a cross-tenant target for an organization admin', async () => {
    mockGetUser.mockResolvedValue({ ...TARGET_USER, organizationId: 99 });

    const response = await resend(TARGET_USER.id);
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe('forbidden');
    expect(mockSendAccountReadyEmail).not.toHaveBeenCalled();
  });

  it('allows a system admin to resend for a valid target tenant', async () => {
    actingUser = ACTING_SYSTEM_ADMIN;

    const response = await resend(TARGET_USER.id);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.emailNotification).toBe('accepted');
    expect(mockSendAccountReadyEmail).toHaveBeenCalledTimes(1);
  });

  it('rejects elevated-role targets and malformed ids', async () => {
    mockGetUser.mockResolvedValue({ ...TARGET_USER, role: 'org_admin' });
    const roleResponse = await resend(TARGET_USER.id);
    expect(roleResponse.status).toBe(403);
    expect(mockSendAccountReadyEmail).not.toHaveBeenCalled();

    mockGetUser.mockReset();
    const malformedResponse = await resend('123abc');
    expect(malformedResponse.status).toBe(400);
    expect(mockGetUser).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated callers before reading the target', async () => {
    actingUser = null;

    const response = await resend(TARGET_USER.id);

    expect(response.status).toBe(401);
    expect(mockGetUser).not.toHaveBeenCalled();
    expect(mockSendAccountReadyEmail).not.toHaveBeenCalled();
  });
});
