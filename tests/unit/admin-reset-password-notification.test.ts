/**
 * Route-level unit test for the admin-driven password-reset
 * security email (task #416). This is the third companion to
 * tests/unit/change-password-notification.test.ts (task #353) and
 * tests/unit/set-password-notification.test.ts (task #409): same
 * `sendPasswordChangedNotification` helper, fired AFTER the
 * password row is persisted, but with `actor: 'admin'` so the
 * recipient sees the "performed by an administrator" line.
 *
 * Mounts the real `organization-admin` router on an isolated
 * express app with all external deps mocked so we can
 * deterministically assert the helper is invoked on success and is
 * NOT invoked on validation, auth, or self-reset failures.
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

const ACTING_ORG_ADMIN = {
  id: 1001,
  email: 'org-admin@vitest.local',
  name: 'Acting Org Admin',
  role: 'org_admin' as const,
  organizationId: 42,
};

const TARGET_USER = {
  id: 2002,
  email: 'reset-target@vitest.local',
  name: 'Reset Target',
  role: 'user' as const,
  organizationId: 42,
  bowlerId: null,
  password: 'hashed:original',
  // Pin a non-default locale so we can assert the route forwards
  // it to the helper (task #410 also covers this for the existing
  // call sites; this test extends the same guarantee to the new
  // admin path).
  preferredLanguage: 'es',
};

const SYSTEM_ADMIN_TARGET = {
  ...TARGET_USER,
  id: 2003,
  email: 'sysadmin-target@vitest.local',
  role: 'system_admin' as const,
};

const CROSS_ORG_TARGET = {
  ...TARGET_USER,
  id: 2004,
  email: 'cross-org-target@vitest.local',
  organizationId: 99,
};

// --- Module mocks. Hoisted by vitest. ----------------------------

const mockSendPasswordChangedNotification = vi.fn(async () => true);
const mockSendInviteEmail = vi.fn(async () => true);
const mockSendTemplatedEmail = vi.fn(async () => true);

vi.mock('../../server/services/email', () => ({
  sendPasswordChangedNotification: (...a: unknown[]) =>
    mockSendPasswordChangedNotification.apply(null, a as never),
  sendInviteEmail: (...a: unknown[]) =>
    mockSendInviteEmail.apply(null, a as never),
  sendTemplatedEmail: (...a: unknown[]) =>
    mockSendTemplatedEmail.apply(null, a as never),
  getBaseUrl: () => 'https://test.example',
  getOrgLogoUrl: () => 'https://test.example/logo.png',
}));

const mockGetUser = vi.fn();
const mockUpdateUser = vi.fn();
const mockRevokePendingAccountActions = vi.fn(async () => 0);
const mockInvalidatePending = vi.fn(async () => 0);

vi.mock('../../server/storage', () => ({
  storage: {
    getUser: (...a: unknown[]) => mockGetUser.apply(null, a as never),
    updateUser: (...a: unknown[]) => mockUpdateUser.apply(null, a as never),
    revokePendingAccountActionsForUser: (...a: unknown[]) =>
      mockRevokePendingAccountActions.apply(null, a as never),
    invalidatePendingEmailChangeRequestsForUser: (...a: unknown[]) =>
      mockInvalidatePending.apply(null, a as never),
  },
}));

const mockRecordAdminPasswordResetAudit = vi.fn(async () => ({ id: 1 }));

vi.mock('../../server/storage/admin-password-reset-audits', () => ({
  recordAdminPasswordResetAudit: (...a: unknown[]) =>
    mockRecordAdminPasswordResetAudit.apply(null, a as never),
}));

// Task #458: the route now wraps the password update + audit insert
// in `db.transaction(...)` so they succeed or fail together. We mock
// `db.transaction` to (a) hand the inner callback a sentinel `tx`
// object so we can assert both writes received the SAME executor and
// (b) re-throw any rejection out of the callback the way drizzle
// would on rollback. This keeps the unit test from needing a real
// Postgres connection while still pinning the atomic contract.
const TX_SENTINEL = {
  __isMockTx: true,
  execute: vi.fn(async () => []),
} as const;
const mockTransaction = vi.fn(
  async (fn: (tx: typeof TX_SENTINEL) => Promise<unknown>) => fn(TX_SENTINEL),
);

vi.mock('../../server/db', () => ({
  db: {
    transaction: (...a: unknown[]) => mockTransaction.apply(null, a as never),
  },
  pool: {},
}));

const mockHashPassword = vi.fn(async (pw: string) => `hashed:${pw}`);
const mockDestroyOtherSessionsForUser = vi.fn(async () => 0);

vi.mock('../../server/auth', () => ({
  hashPassword: (...a: unknown[]) => mockHashPassword.apply(null, a as never),
  destroyOtherSessionsForUser: (...a: unknown[]) =>
    mockDestroyOtherSessionsForUser.apply(null, a as never),
}));

// Bypass the per-route rate limiter so we can hammer the same IP
// without tripping the cap. Rate-limit behavior is covered
// elsewhere; this test only cares about the email-dispatch wiring.
vi.mock('express-rate-limit', () => ({
  default: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  ipKeyGenerator: (ip: string) => ip,
}));

// Now import the real router with all of its deps mocked.
const orgAdminRouter = (await import('../../server/routes/organization-admin')).default;

// --- Test express app harness. -----------------------------------

let server: Server;
let baseUrl: string;
let actingUser: typeof ACTING_ORG_ADMIN | null = ACTING_ORG_ADMIN;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as {
      user: typeof ACTING_ORG_ADMIN | null;
      isAuthenticated: () => boolean;
      ip: string;
    }).user = actingUser;
    (req as unknown as { isAuthenticated: () => boolean }).isAuthenticated = () =>
      actingUser !== null;
    Object.defineProperty(req, 'ip', { value: '198.51.100.42', configurable: true });
    next();
  });
  app.use('/api/organization-admin', orgAdminRouter);
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
  actingUser = ACTING_ORG_ADMIN;
  mockSendPasswordChangedNotification.mockClear();
  mockSendPasswordChangedNotification.mockResolvedValue(true);
  mockGetUser.mockReset();
  mockGetUser.mockResolvedValue({ ...TARGET_USER });
  mockUpdateUser.mockReset();
  mockUpdateUser.mockResolvedValue({ ...TARGET_USER, password: 'hashed:new' });
  mockRevokePendingAccountActions.mockClear();
  mockInvalidatePending.mockClear();
  mockHashPassword.mockClear();
  mockDestroyOtherSessionsForUser.mockClear();
  mockRecordAdminPasswordResetAudit.mockReset();
  mockRecordAdminPasswordResetAudit.mockResolvedValue({ id: 1 } as never);
  mockTransaction.mockClear();
  mockTransaction.mockImplementation(
    async (fn: (tx: typeof TX_SENTINEL) => Promise<unknown>) => fn(TX_SENTINEL),
  );
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

async function postReset(targetId: number, body: unknown) {
  return fetch(`${baseUrl}/api/organization-admin/users/${targetId}/reset-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/organization-admin/users/:id/reset-password — admin-driven password-changed email dispatch (task #416)', () => {
  it('invokes sendPasswordChangedNotification with actor="admin" and the target email/name/locale after a successful reset', async () => {
    const res = await postReset(TARGET_USER.id, { newPassword: 'BrandNewPw!2026XX' });
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
        actor?: 'self' | 'admin';
      },
    ];
    const [toEmail, name, ctx] = call;
    // Email goes to the TARGET user, not the acting admin.
    expect(toEmail).toBe(TARGET_USER.email);
    expect(name).toBe(TARGET_USER.name);
    expect(ctx.changedAt).toBeInstanceOf(Date);
    expect(ctx.ipAddress).toBe('198.51.100.42');
    expect(typeof ctx.userAgent === 'string' || ctx.userAgent === null).toBe(true);
    // task #410 — preferred locale must flow through to the helper
    // for admin-driven resets just like the other two call sites.
    expect(ctx.locale).toBe('es');
    // The whole point of #416 — without this flag the body would
    // not include the "performed by an administrator" sentence,
    // and the recipient would have no way to tell this apart from
    // a self-service rotation.
    expect(ctx.actor).toBe('admin');

    // Strict ordering: the password row must be persisted BEFORE we
    // dispatch the notice. Otherwise a crash between the two could
    // send a misleading "your password was just changed" email.
    const updateOrder = mockUpdateUser.mock.invocationCallOrder[0];
    const notifyOrder =
      mockSendPasswordChangedNotification.mock.invocationCallOrder[0];
    expect(updateOrder).toBeLessThan(notifyOrder);
  });

  it('does NOT invoke the helper when the new password fails the strength check', async () => {
    const res = await postReset(TARGET_USER.id, { newPassword: 'short' });
    expect(res.status).toBe(400);
    await flushFireAndForget();
    expect(mockSendPasswordChangedNotification).not.toHaveBeenCalled();
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('does NOT invoke the helper when the target user does not exist', async () => {
    mockGetUser.mockResolvedValueOnce(undefined);
    const res = await postReset(999_999, { newPassword: 'BrandNewPw!2026XX' });
    expect(res.status).toBe(404);
    await flushFireAndForget();
    expect(mockSendPasswordChangedNotification).not.toHaveBeenCalled();
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('does NOT invoke the helper when the admin tries to reset their OWN password (must use change-password)', async () => {
    mockGetUser.mockResolvedValueOnce({ ...TARGET_USER, id: ACTING_ORG_ADMIN.id });
    const res = await postReset(ACTING_ORG_ADMIN.id, { newPassword: 'BrandNewPw!2026XX' });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error?.message).toMatch(/change-password/i);
    await flushFireAndForget();
    expect(mockSendPasswordChangedNotification).not.toHaveBeenCalled();
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('does NOT invoke the helper when the target is a system_admin (defense-in-depth)', async () => {
    mockGetUser.mockResolvedValueOnce({ ...SYSTEM_ADMIN_TARGET });
    const res = await postReset(SYSTEM_ADMIN_TARGET.id, { newPassword: 'BrandNewPw!2026XX' });
    expect(res.status).toBe(403);
    await flushFireAndForget();
    expect(mockSendPasswordChangedNotification).not.toHaveBeenCalled();
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('does NOT invoke the helper when an org_admin tries to reset a user in a DIFFERENT organization', async () => {
    mockGetUser.mockResolvedValueOnce({ ...CROSS_ORG_TARGET });
    const res = await postReset(CROSS_ORG_TARGET.id, { newPassword: 'BrandNewPw!2026XX' });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error?.message).toMatch(/your own organization/i);
    await flushFireAndForget();
    expect(mockSendPasswordChangedNotification).not.toHaveBeenCalled();
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('does NOT invoke the helper when the caller is unauthenticated', async () => {
    actingUser = null;
    try {
      const res = await postReset(TARGET_USER.id, { newPassword: 'BrandNewPw!2026XX' });
      expect(res.status).toBe(401);
      await flushFireAndForget();
      expect(mockSendPasswordChangedNotification).not.toHaveBeenCalled();
      expect(mockUpdateUser).not.toHaveBeenCalled();
    } finally {
      actingUser = ACTING_ORG_ADMIN;
    }
  });

  it('does NOT invoke the helper when the caller is authenticated but a regular user (role="user")', async () => {
    // Authorization regression guard: the route guard is
    // `requireOrgAdminOrSystemAdmin`, so a logged-in non-admin must
    // be rejected with 403 before any side effects fire. Without
    // this case a future refactor that loosened the middleware
    // would silently let any user nuke any other user's password.
    actingUser = {
      ...ACTING_ORG_ADMIN,
      id: 5005,
      role: 'user' as unknown as 'org_admin',
    };
    try {
      const res = await postReset(TARGET_USER.id, { newPassword: 'BrandNewPw!2026XX' });
      expect(res.status).toBe(403);
      await flushFireAndForget();
      expect(mockSendPasswordChangedNotification).not.toHaveBeenCalled();
      expect(mockUpdateUser).not.toHaveBeenCalled();
      // The route must not even look up the target user when the
      // caller fails the role check.
      expect(mockGetUser).not.toHaveBeenCalled();
    } finally {
      actingUser = ACTING_ORG_ADMIN;
    }
  });

  // Task #455: pin that the reset endpoint writes the
  // `mustChangePassword` flag in the SAME update as the new password
  // hash. Without this, an admin who resets a user's password
  // necessarily knows the working password until the user happens to
  // rotate it — a real impersonation window.
  it('writes mustChangePassword=true in the same updateUser call as the new password hash (task #455)', async () => {
    const res = await postReset(TARGET_USER.id, { newPassword: 'BrandNewPw!2026XX' });
    expect(res.status).toBe(200);
    expect(mockUpdateUser).toHaveBeenCalledTimes(1);
    const [updateId, updatePatch] = mockUpdateUser.mock.calls[0] as unknown as [
      number,
      { password?: string; mustChangePassword?: boolean },
    ];
    expect(updateId).toBe(TARGET_USER.id);
    // The password is hashed via the mocked hashPassword (`hashed:${pw}`).
    expect(updatePatch.password).toBe('hashed:BrandNewPw!2026XX');
    // The flag MUST be true. A regression that drops it would
    // silently leave the admin with a working credential.
    expect(updatePatch.mustChangePassword).toBe(true);
  });

  it('still returns 200 when the email helper rejects (best-effort contract — password rotation is not rolled back)', async () => {
    // The route logs the swallowed email failure at [ERROR] on purpose.
    expectErrorLog(/Password-changed notification threw \(admin reset\)/);
    mockSendPasswordChangedNotification.mockRejectedValueOnce(
      new Error('SendGrid 503'),
    );
    const res = await postReset(TARGET_USER.id, { newPassword: 'BrandNewPw!2026XX' });
    expect(res.status).toBe(200);
    await flushFireAndForget();
    expect(mockSendPasswordChangedNotification).toHaveBeenCalledTimes(1);
    expect(mockUpdateUser).toHaveBeenCalledTimes(1);
  });

  it('a system_admin (no org) can reset a user in any organization', async () => {
    // The middleware allows system_admin through unconditionally,
    // and the cross-org guard only fires for org_admin callers.
    // The test harness's `req.user` cast is intentionally loose so
    // we can swap roles per-test without restructuring the harness.
    actingUser = {
      id: 9000,
      email: 'sysadmin@vitest.local',
      name: 'Sys Admin',
      role: 'system_admin',
      organizationId: null,
    } as unknown as typeof ACTING_ORG_ADMIN;
    mockGetUser.mockResolvedValueOnce({ ...CROSS_ORG_TARGET });
    try {
      const res = await postReset(CROSS_ORG_TARGET.id, { newPassword: 'BrandNewPw!2026XX' });
      expect(res.status).toBe(200);
      await flushFireAndForget();
      expect(mockSendPasswordChangedNotification).toHaveBeenCalledTimes(1);
      const ctx = (mockSendPasswordChangedNotification.mock.calls[0] as unknown as Array<{ actor?: string }>)[2];
      expect(ctx.actor).toBe('admin');
      expect(mockUpdateUser).toHaveBeenCalledTimes(1);
    } finally {
      actingUser = ACTING_ORG_ADMIN;
    }
  });
});

describe('POST /api/organization-admin/users/:id/reset-password — persistent audit row (task #424)', () => {
  it('writes one audit row with actor/target/org/ip/UA on success, sandwiched between updateUser and the response', async () => {
    const res = await postReset(TARGET_USER.id, { newPassword: 'BrandNewPw!2026XX' });
    expect(res.status).toBe(200);

    expect(mockRecordAdminPasswordResetAudit).toHaveBeenCalledTimes(1);
    const [auditValues] = mockRecordAdminPasswordResetAudit.mock.calls[0] as unknown as [
      {
        actorUserId: number;
        targetUserId: number;
        organizationId: number | null;
        ipAddress: string | null;
        userAgent: string | null;
      },
    ];
    expect(auditValues.actorUserId).toBe(ACTING_ORG_ADMIN.id);
    expect(auditValues.targetUserId).toBe(TARGET_USER.id);
    expect(auditValues.organizationId).toBe(TARGET_USER.organizationId);
    expect(auditValues.ipAddress).toBe('198.51.100.42');
    expect(typeof auditValues.userAgent === 'string' || auditValues.userAgent === null).toBe(true);

    // Strict ordering: the audit row MUST be written AFTER the password
    // row (otherwise we record a reset that hasn't actually happened
    // yet) and BEFORE the response is sent (so a successful 200 implies
    // a queryable audit trail). The fire-and-forget password-changed
    // notification fires synchronously right before sendSuccess, so the
    // audit-then-notify order proves the audit ran before the response.
    const updateOrder = mockUpdateUser.mock.invocationCallOrder[0];
    const auditOrder = mockRecordAdminPasswordResetAudit.mock.invocationCallOrder[0];
    const notifyOrder = mockSendPasswordChangedNotification.mock.invocationCallOrder[0];
    expect(updateOrder).toBeLessThan(auditOrder);
    expect(auditOrder).toBeLessThan(notifyOrder);
  });

  it('records the acting system_admin and the target user when a system_admin resets a cross-org user', async () => {
    actingUser = {
      id: 9000,
      email: 'sysadmin@vitest.local',
      name: 'Sys Admin',
      role: 'system_admin',
      organizationId: null,
    } as unknown as typeof ACTING_ORG_ADMIN;
    mockGetUser.mockResolvedValueOnce({ ...CROSS_ORG_TARGET });
    try {
      const res = await postReset(CROSS_ORG_TARGET.id, { newPassword: 'BrandNewPw!2026XX' });
      expect(res.status).toBe(200);
      expect(mockRecordAdminPasswordResetAudit).toHaveBeenCalledTimes(1);
      const [auditValues] = mockRecordAdminPasswordResetAudit.mock.calls[0] as unknown as [
        { actorUserId: number; targetUserId: number; organizationId: number | null },
      ];
      expect(auditValues.actorUserId).toBe(9000);
      expect(auditValues.targetUserId).toBe(CROSS_ORG_TARGET.id);
      // organizationId is the TARGET's org, not the actor's — that's
      // what makes the row queryable per-tenant.
      expect(auditValues.organizationId).toBe(CROSS_ORG_TARGET.organizationId);
    } finally {
      actingUser = ACTING_ORG_ADMIN;
    }
  });

  it('does NOT write an audit row when validation fails', async () => {
    const res = await postReset(TARGET_USER.id, { newPassword: 'short' });
    expect(res.status).toBe(400);
    expect(mockRecordAdminPasswordResetAudit).not.toHaveBeenCalled();
  });

  it('does NOT write an audit row when the target user does not exist', async () => {
    mockGetUser.mockResolvedValueOnce(undefined);
    const res = await postReset(999_999, { newPassword: 'BrandNewPw!2026XX' });
    expect(res.status).toBe(404);
    expect(mockRecordAdminPasswordResetAudit).not.toHaveBeenCalled();
  });

  it('does NOT write an audit row when the admin tries to reset their own password', async () => {
    mockGetUser.mockResolvedValueOnce({ ...TARGET_USER, id: ACTING_ORG_ADMIN.id });
    const res = await postReset(ACTING_ORG_ADMIN.id, { newPassword: 'BrandNewPw!2026XX' });
    expect(res.status).toBe(403);
    expect(mockRecordAdminPasswordResetAudit).not.toHaveBeenCalled();
  });

  it('does NOT write an audit row when the target is a system_admin', async () => {
    mockGetUser.mockResolvedValueOnce({ ...SYSTEM_ADMIN_TARGET });
    const res = await postReset(SYSTEM_ADMIN_TARGET.id, { newPassword: 'BrandNewPw!2026XX' });
    expect(res.status).toBe(403);
    expect(mockRecordAdminPasswordResetAudit).not.toHaveBeenCalled();
  });

  it('does NOT write an audit row when an org_admin reaches across organizations', async () => {
    mockGetUser.mockResolvedValueOnce({ ...CROSS_ORG_TARGET });
    const res = await postReset(CROSS_ORG_TARGET.id, { newPassword: 'BrandNewPw!2026XX' });
    expect(res.status).toBe(403);
    expect(mockRecordAdminPasswordResetAudit).not.toHaveBeenCalled();
  });

  it('does NOT write an audit row when the caller is unauthenticated', async () => {
    actingUser = null;
    try {
      const res = await postReset(TARGET_USER.id, { newPassword: 'BrandNewPw!2026XX' });
      expect(res.status).toBe(401);
      expect(mockRecordAdminPasswordResetAudit).not.toHaveBeenCalled();
    } finally {
      actingUser = ACTING_ORG_ADMIN;
    }
  });

  it('returns 500 and does NOT send the response with success when the audit insert fails (fail-closed compliance contract)', async () => {
    // The fail-closed branch logs the underlying error at [ERROR] on purpose.
    expectErrorLog(/Error resetting user password:/);
    mockRecordAdminPasswordResetAudit.mockRejectedValueOnce(new Error('DB unavailable'));
    const res = await postReset(TARGET_USER.id, { newPassword: 'BrandNewPw!2026XX' });
    expect(res.status).toBe(500);
    // The password update was attempted inside the transaction (so a
    // future maintainer can see we tried), but task #458 now wraps
    // both writes in `db.transaction(...)` — see the dedicated test
    // below for the rollback guarantee.
    expect(mockUpdateUser).toHaveBeenCalledTimes(1);
    // Critically, when the audit fails we must NOT have proceeded to
    // dispatch the password-changed email — otherwise the recipient
    // gets a "your password just changed" notice for an action with
    // no audit trail.
    await flushFireAndForget();
    expect(mockSendPasswordChangedNotification).not.toHaveBeenCalled();
  });

  // Task #458: the password update and the audit insert run inside a
  // single `db.transaction(...)`. These tests pin the contract at the
  // route level — both writes share the same `tx` executor, and when
  // the audit insert rejects the rollback semantics are preserved
  // (the rejection escapes the transaction callback so drizzle would
  // ROLLBACK the password write in production). Without the
  // transaction wrapper, a maintainer could re-introduce the
  // partial-write window the task fixed.
  describe('atomicity with the password update (task #458)', () => {
    it('runs the password update and the audit insert inside the same db.transaction', async () => {
      const res = await postReset(TARGET_USER.id, { newPassword: 'BrandNewPw!2026XX' });
      expect(res.status).toBe(200);

      // The route must open exactly one transaction for the rotation
      // — not two separate ones, and not zero (which would mean the
      // writes can diverge again).
      expect(mockTransaction).toHaveBeenCalledTimes(1);

      // Both writes must have received the SAME executor handed to
      // them by `db.transaction(...)`. If a future refactor passed
      // `db` (the top-level connection) instead of `tx` to either
      // call, that write would commit OUTSIDE the transaction and
      // the rollback contract would silently break.
      expect(mockUpdateUser).toHaveBeenCalledTimes(1);
      const updateCall = mockUpdateUser.mock.calls[0] as unknown as [
        number,
        Record<string, unknown>,
        unknown,
      ];
      expect(updateCall[2]).toBe(TX_SENTINEL);

      expect(mockRevokePendingAccountActions).toHaveBeenCalledWith(
        TARGET_USER.id,
        ['password_reset'],
        TX_SENTINEL,
      );
      expect(mockInvalidatePending).toHaveBeenCalledWith(
        TARGET_USER.id,
        TX_SENTINEL,
      );

      expect(mockRecordAdminPasswordResetAudit).toHaveBeenCalledTimes(1);
      const auditCall = mockRecordAdminPasswordResetAudit.mock.calls[0] as unknown as [
        Record<string, unknown>,
        unknown,
      ];
      expect(auditCall[1]).toBe(TX_SENTINEL);
    });

    it('rolls back (transaction rejects) and surfaces 500 when the audit insert throws — no observable password write outside the rolled-back transaction', async () => {
      // The fail-closed branch logs the underlying error at [ERROR] on purpose.
      expectErrorLog(/Error resetting user password:/);
      mockRecordAdminPasswordResetAudit.mockRejectedValueOnce(
        new Error('audit insert boom'),
      );

      // Track whether the transaction callback rejected — that is
      // what makes drizzle ROLLBACK the password update at the DB
      // level. Without this propagation the write would commit even
      // though the audit failed.
      let txRejected = false;
      mockTransaction.mockImplementationOnce(
        async (fn: (tx: typeof TX_SENTINEL) => Promise<unknown>) => {
          try {
            return await fn(TX_SENTINEL);
          } catch (err) {
            txRejected = true;
            throw err;
          }
        },
      );

      const res = await postReset(TARGET_USER.id, { newPassword: 'BrandNewPw!2026XX' });
      expect(res.status).toBe(500);

      // The transaction MUST have rejected so drizzle would issue
      // ROLLBACK in production. If a future refactor swallowed the
      // audit error inside the callback, this assertion fails and
      // the rollback contract is gone.
      expect(txRejected).toBe(true);

      // `storage.updateUser` was invoked (so a maintainer can see we
      // tried to write the password), but it ran inside the failed
      // transaction so the row is not observable outside it. We
      // assert the executor was the SAME `tx` that the audit threw
      // under — proving both writes share one rollback fate.
      expect(mockUpdateUser).toHaveBeenCalledTimes(1);
      const updateCall = mockUpdateUser.mock.calls[0] as unknown as [
        number,
        Record<string, unknown>,
        unknown,
      ];
      expect(updateCall[2]).toBe(TX_SENTINEL);

      // No password-changed email may fire when the audit fails —
      // the email helper is dispatched AFTER the transaction
      // commits, so a rejected transaction must short-circuit it.
      await flushFireAndForget();
      expect(mockSendPasswordChangedNotification).not.toHaveBeenCalled();
    });
  });
});
