/**
 * Route-level unit test for the change-password security email
 * (task #353). Mounts the real `account` router on an isolated express
 * app with the email module mocked so we can deterministically assert
 * that `sendPasswordChangedNotification` is invoked after a successful
 * password rotation — and is NOT invoked on validation, auth, or
 * "wrong current password" failures.
 *
 * This is the in-process companion to the integration coverage in
 * `tests/api/change-password.test.ts`, which can only verify the
 * outward symptoms (200 + non-blocking response) because the live
 * server runs in a separate process where module spies don't reach.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { expectErrorLog } from '../helpers/expected-error-logs';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const TEST_USER = {
  id: 4242,
  email: 'cp-notify@vitest.local',
  name: 'CP Notify Tester',
  role: 'user' as const,
  organizationId: 9,
  bowlerId: null,
  password: 'hashed:original',
  // task #410 — verify the route reads this column and forwards it
  // to the email helper so the notification renders in the user's
  // preferred language. Spanish was chosen because it's the second
  // bundled translation; any non-default value would prove wiring.
  preferredLanguage: 'es',
};

// --- Module mocks. These must be declared before the route module
// is imported because vitest hoists `vi.mock` calls but resolves the
// imported router lazily below. ----------------------------------

const mockSendPasswordChangedNotification = vi.fn(async () => true);
const mockSendDeletionRequestNotification = vi.fn(async () => true);
const mockSendEmailChangeConfirmation = vi.fn(async () => true);
const mockSendEmailChangeNotification = vi.fn(async () => true);

vi.mock('../../server/services/email', () => ({
  sendDeletionRequestNotification: (...a: unknown[]) =>
    mockSendDeletionRequestNotification.apply(null, a as never),
  sendEmailChangeConfirmation: (...a: unknown[]) =>
    mockSendEmailChangeConfirmation.apply(null, a as never),
  sendEmailChangeNotification: (...a: unknown[]) =>
    mockSendEmailChangeNotification.apply(null, a as never),
  sendPasswordChangedNotification: (...a: unknown[]) =>
    mockSendPasswordChangedNotification.apply(null, a as never),
  getBaseUrl: () => 'https://test.example',
}));

const mockGetUser = vi.fn();
const mockUpdateUser = vi.fn();
const mockRevokePendingAccountActions = vi.fn(async () => 0);
const mockInvalidatePending = vi.fn(async () => 0);
// The change-password route also drives the lockout counter (task #357).
// Mock both methods faithfully so the route's normal calls don't fall
// through to "is not a function" and log incidental [ERROR] noise on the
// happy / wrong-password paths.
const mockRecordFailedAttempt = vi.fn(async () => ({
  count: 1,
  lockedUntil: null as string | null,
  justLocked: false,
}));
const mockResetFailedAttempts = vi.fn(async () => undefined);

vi.mock('../../server/storage', () => ({
  storage: {
    getUser: (...a: unknown[]) => mockGetUser.apply(null, a as never),
    updateUser: (...a: unknown[]) => mockUpdateUser.apply(null, a as never),
    revokePendingAccountActionsForUser: (...a: unknown[]) =>
      mockRevokePendingAccountActions.apply(null, a as never),
    invalidatePendingEmailChangeRequestsForUser: (...a: unknown[]) =>
      mockInvalidatePending.apply(null, a as never),
    recordFailedPasswordChangeAttempt: (...a: unknown[]) =>
      mockRecordFailedAttempt.apply(null, a as never),
    resetFailedPasswordChangeAttempts: (...a: unknown[]) =>
      mockResetFailedAttempts.apply(null, a as never),
  },
}));

const mockHashPassword = vi.fn(async (pw: string) => `hashed:${pw}`);
const mockDestroyOtherSessionsForUser = vi.fn(async () => 0);

vi.mock('../../server/auth', () => ({
  hashPassword: (...a: unknown[]) => mockHashPassword.apply(null, a as never),
  destroyOtherSessionsForUser: (...a: unknown[]) =>
    mockDestroyOtherSessionsForUser.apply(null, a as never),
}));

const mockComparePasswords = vi.fn(async (provided: string, stored: string) => {
  return provided === 'OriginalPw!2026' && stored === 'hashed:original';
});

vi.mock('../../server/lib/password', () => ({
  comparePasswords: (...a: unknown[]) => mockComparePasswords.apply(null, a as never),
}));

vi.mock('../../server/services/payment-customer-sync', () => ({
  syncBowlerForUser: vi.fn(async () => ({ ok: true })),
}));

// `account.ts` imports the live `db` object at module scope for some
// routes (deletion-request listing) we don't exercise here. Stub it
// out as an empty shell so the import chain doesn't try to spin up a
// real Postgres connection.
vi.mock('../../server/db', () => ({
  db: {
    transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ __isMockTx: true, execute: async () => [] }),
    select: () => ({ from: () => ({ where: () => [] }) }),
    insert: () => ({ values: () => ({ returning: () => [] }) }),
    update: () => ({ set: () => ({ where: () => [] }) }),
    delete: () => ({ where: () => [] }),
  },
}));

vi.mock('../../server/storage/admin-email-change-audits', () => ({
  recordAdminEmailChangeAudit: vi.fn(async () => undefined),
}));

vi.mock('../../server/middleware/auth', () => ({
  requireSystemAdmin: (_req: Request, _res: Response, next: NextFunction) =>
    next(),
}));

// Now import the real router with all of its deps mocked.
const accountRouter = (await import('../../server/routes/account')).default;

// --- Test express app harness. ----------------------------------

let server: Server;
let baseUrl: string;
let authenticated = true;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // Stand in for passport: tag every request with a fake user that
  // matches our DB stub, and a working `isAuthenticated`.
  app.use((req, _res, next) => {
    (req as unknown as {
      user: typeof TEST_USER;
      isAuthenticated: () => boolean;
      sessionID: string;
      ip: string;
    }).user = TEST_USER;
    (req as unknown as { isAuthenticated: () => boolean }).isAuthenticated = () =>
      authenticated;
    (req as unknown as { sessionID: string }).sessionID = 'sess-test-1';
    Object.defineProperty(req, 'ip', { value: '203.0.113.42', configurable: true });
    next();
  });
  app.use('/api/account', accountRouter);
  await new Promise<void>(resolve => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close(err => (err ? reject(err) : resolve())),
  );
});

beforeEach(() => {
  authenticated = true;
  mockSendPasswordChangedNotification.mockClear();
  mockSendPasswordChangedNotification.mockResolvedValue(true);
  mockGetUser.mockReset();
  mockGetUser.mockResolvedValue({ ...TEST_USER });
  mockUpdateUser.mockReset();
  mockUpdateUser.mockResolvedValue({ ...TEST_USER, password: 'hashed:new' });
  mockRevokePendingAccountActions.mockClear();
  mockInvalidatePending.mockClear();
  mockHashPassword.mockClear();
  mockDestroyOtherSessionsForUser.mockClear();
  mockComparePasswords.mockClear();
});

afterEach(() => vi.clearAllMocks());

async function flushFireAndForget() {
  // The route schedules the email send as `void send().then().catch()`
  // and responds immediately. Yield the event loop a couple of times
  // so any microtask queued by that promise chain has run before we
  // assert.
  for (let i = 0; i < 5; i++) {
    await new Promise(r => setImmediate(r));
  }
}

async function postChangePassword(body: unknown) {
  return fetch(`${baseUrl}/api/account/change-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/account/change-password — password-changed email dispatch', () => {
  it('invokes sendPasswordChangedNotification with the user email/name and request context after a successful change', async () => {
    const res = await postChangePassword({
      currentPassword: 'OriginalPw!2026',
      newPassword: 'BrandNewPw!2026XX',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    await flushFireAndForget();

    expect(mockSendPasswordChangedNotification).toHaveBeenCalledTimes(1);
    const call = mockSendPasswordChangedNotification.mock.calls[0] as unknown as [
      string,
      string,
      {
        changedAt: Date;
        ipAddress: string | null;
        userAgent: string | null;
        locale?: string | null;
      },
    ];
    const [toEmail, name, ctx] = call;
    expect(toEmail).toBe(TEST_USER.email);
    expect(name).toBe(TEST_USER.name);
    expect(ctx.changedAt).toBeInstanceOf(Date);
    expect(ctx.ipAddress).toBe('203.0.113.42');
    // node-fetch sets a UA header on outgoing requests; the helper
    // shouldn't get an empty string when the caller has one.
    expect(typeof ctx.userAgent === 'string' || ctx.userAgent === null).toBe(true);
    // task #410 — the recipient's stored language preference must
    // flow through to the email helper, otherwise the email always
    // renders in English regardless of preference.
    expect(ctx.locale).toBe('es');

    expect(mockRevokePendingAccountActions).toHaveBeenCalledWith(
      TEST_USER.id,
      ['password_reset'],
      expect.objectContaining({ __isMockTx: true }),
    );
    expect(mockInvalidatePending).toHaveBeenCalledWith(
      TEST_USER.id,
      expect.objectContaining({ __isMockTx: true }),
    );

    // Strict ordering: the password row must be persisted BEFORE we
    // dispatch the "your password was changed" email. Otherwise a
    // crash between the two could send a misleading notice.
    const updateOrder = mockUpdateUser.mock.invocationCallOrder[0];
    const notifyOrder =
      mockSendPasswordChangedNotification.mock.invocationCallOrder[0];
    expect(updateOrder).toBeLessThan(notifyOrder);
  });

  it('does NOT invoke sendPasswordChangedNotification when the current password is wrong', async () => {
    const res = await postChangePassword({
      currentPassword: 'totally-wrong',
      newPassword: 'BrandNewPw!2026XX',
    });
    expect(res.status).toBe(400);

    await flushFireAndForget();

    expect(mockSendPasswordChangedNotification).not.toHaveBeenCalled();
    // Defense-in-depth sanity: the password must not have been written.
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('does NOT invoke sendPasswordChangedNotification when the new password fails the strength check', async () => {
    const res = await postChangePassword({
      currentPassword: 'OriginalPw!2026',
      newPassword: 'short',
    });
    expect(res.status).toBe(400);

    await flushFireAndForget();

    expect(mockSendPasswordChangedNotification).not.toHaveBeenCalled();
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('does not overwrite a password changed by an administrator during verification', async () => {
    mockGetUser
      .mockResolvedValueOnce({ ...TEST_USER })
      .mockResolvedValueOnce({ ...TEST_USER, password: 'hashed:admin-reset' });

    const res = await postChangePassword({
      currentPassword: 'OriginalPw!2026',
      newPassword: 'BrandNewPw!2026XX',
    });

    expect(res.status).toBe(409);
    expect(mockUpdateUser).not.toHaveBeenCalled();
    expect(mockRevokePendingAccountActions).not.toHaveBeenCalled();
    expect(mockInvalidatePending).not.toHaveBeenCalled();
    expect(mockSendPasswordChangedNotification).not.toHaveBeenCalled();
  });

  it('still returns 200 for the change-password call when the email helper rejects (best-effort contract)', async () => {
    // The route logs the swallowed email failure at [ERROR] on purpose.
    expectErrorLog(/Password-changed notification threw unexpectedly/);
    mockSendPasswordChangedNotification.mockRejectedValueOnce(
      new Error('SendGrid 503'),
    );

    const res = await postChangePassword({
      currentPassword: 'OriginalPw!2026',
      newPassword: 'BrandNewPw!2026XX',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    await flushFireAndForget();

    // The helper WAS called (proving the wiring), and the route still
    // succeeded — the password rotation is not rolled back by an
    // outbound email failure.
    expect(mockSendPasswordChangedNotification).toHaveBeenCalledTimes(1);
    expect(mockUpdateUser).toHaveBeenCalledTimes(1);
  });
});
