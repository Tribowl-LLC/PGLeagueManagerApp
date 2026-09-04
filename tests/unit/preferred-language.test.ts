/**
 * Round-trip coverage for the user-preferred-language feature
 * (tasks #410 / #417):
 *
 *   account-settings UI  →  PATCH /api/account/profile/:id
 *                       →  storage.updateUser({ preferredLanguage })
 *                       →  POST /api/account/change-password later
 *                       →  sendPasswordChangedNotification({ locale: <chosen> })
 *
 * #410 wired the email helper to honour `users.preferred_language`,
 * but until #417 there was no way to actually set the column from
 * the UI — every recipient still got English. This test pins the
 * write side of that loop:
 *   - PATCH persists a known language code on the user row.
 *   - PATCH persists `null` to clear the preference.
 *   - PATCH rejects an unknown / unsupported code with 400 instead
 *     of writing a value the email helper would silently fall back
 *     on.
 *   - The route's accepted set is sourced from the bundled
 *     translations (`PASSWORD_CHANGED_I18N`), so adding a locale to
 *     the email bundle automatically widens what the API accepts.
 *
 * The "stored language flows into the next password-changed email"
 * half of the round trip is already pinned by
 * `tests/unit/change-password-notification.test.ts` (which sets
 * `TEST_USER.preferredLanguage = 'es'` and asserts the helper
 * receives `locale: 'es'`).
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
import express, { type NextFunction, type Request, type Response } from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { PASSWORD_CHANGED_I18N } from '../../server/services/email-i18n/password-changed';

const TEST_USER = {
  id: 7777,
  email: 'lang@vitest.local',
  name: 'Lang Tester',
  role: 'user' as const,
  organizationId: 9,
  bowlerId: null,
  password: 'hashed:original',
  preferredLanguage: null as string | null,
};

// --- Module mocks (same shape as change-password-notification.test.ts).

// Captured by closure inside the factory below so we can assert
// against it after the change-password route fires its
// best-effort notification.
const mockSendPasswordChangedNotification = vi.fn(async () => true);

vi.mock('../../server/services/email', () => ({
  sendDeletionRequestNotification: vi.fn(async () => true),
  sendEmailChangeConfirmation: vi.fn(async () => true),
  sendEmailChangeNotification: vi.fn(async () => true),
  sendPasswordChangedNotification: (...a: unknown[]) =>
    mockSendPasswordChangedNotification.apply(null, a as never),
  getBaseUrl: () => 'https://test.example',
}));

const mockGetUser = vi.fn();
const mockUpdateUser = vi.fn();
const mockInvalidatePending = vi.fn(async () => 0);

vi.mock('../../server/storage', () => ({
  storage: {
    getUser: (...a: unknown[]) => mockGetUser.apply(null, a as never),
    updateUser: (...a: unknown[]) => mockUpdateUser.apply(null, a as never),
    revokePendingAccountActionsForUser: vi.fn(async () => 0),
    invalidatePendingEmailChangeRequestsForUser: (...a: unknown[]) =>
      mockInvalidatePending.apply(null, a as never),
    getUserByEmail: vi.fn(async () => null),
    getOrganization: vi.fn(async () => null),
    // The change-password route drives the lockout counter (task #357).
    // Mock both methods faithfully so the route's normal calls don't
    // fall through to "is not a function" and log incidental [ERROR]
    // noise on the success path this test exercises.
    recordFailedPasswordChangeAttempt: vi.fn(async () => ({
      count: 1,
      lockedUntil: null as string | null,
      justLocked: false,
    })),
    resetFailedPasswordChangeAttempts: vi.fn(async () => undefined),
  },
}));

vi.mock('../../server/auth', () => ({
  hashPassword: vi.fn(async (pw: string) => `hashed:${pw}`),
  destroyOtherSessionsForUser: vi.fn(async () => 0),
}));

vi.mock('../../server/lib/password', () => ({
  comparePasswords: vi.fn(async () => true),
}));

vi.mock('../../server/services/payment-customer-sync', () => ({
  syncBowlerForUser: vi.fn(async () => ({ ok: true })),
}));

vi.mock('../../server/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => [] }) }),
    insert: () => ({ values: () => ({ returning: () => [] }) }),
    update: () => ({ set: () => ({ where: () => [] }) }),
    delete: () => ({ where: () => [] }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
  },
}));

vi.mock('../../server/storage/admin-email-change-audits', () => ({
  recordAdminEmailChangeAudit: vi.fn(async () => undefined),
}));

vi.mock('../../server/middleware/auth', () => ({
  requireSystemAdmin: (_req: Request, _res: Response, next: NextFunction) =>
    next(),
}));

const accountRouter = (await import('../../server/routes/account')).default;
const { SUPPORTED_PREFERRED_LANGUAGES, profileUpdateSchema } = await import(
  '../../server/routes/account'
);

// --- Test express app harness.

let server: Server;
let baseUrl: string;
let authenticated = true;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
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
  mockGetUser.mockReset();
  mockGetUser.mockResolvedValue({ ...TEST_USER });
  mockUpdateUser.mockReset();
  mockUpdateUser.mockImplementation(async (_id: number, patch: Record<string, unknown>) => ({
    ...TEST_USER,
    ...patch,
  }));
  mockSendPasswordChangedNotification.mockClear();
  mockSendPasswordChangedNotification.mockResolvedValue(true);
});

afterEach(() => vi.clearAllMocks());

async function patchProfile(body: unknown) {
  return fetch(`${baseUrl}/api/account/profile/${TEST_USER.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function postChangePassword(body: unknown) {
  return fetch(`${baseUrl}/api/account/change-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// The change-password route dispatches the email helper as
// fire-and-forget. Yield the microtask queue a few times so the
// floating promise settles before we inspect the mock.
async function flushFireAndForget() {
  for (let i = 0; i < 5; i++) {
    await new Promise(r => setImmediate(r));
  }
}

describe('PATCH /api/account/profile — preferredLanguage round trip', () => {
  it("accepts a known locale and forwards it to storage.updateUser as the column's new value", async () => {
    const res = await patchProfile({ preferredLanguage: 'es' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    // The sanitized response now exposes the chosen language so the
    // UI can re-hydrate the dropdown without an extra round trip.
    expect(body.data.preferredLanguage).toBe('es');

    expect(mockUpdateUser).toHaveBeenCalledTimes(1);
    const [, patch] = mockUpdateUser.mock.calls[0] as [number, Record<string, unknown>];
    // Only the preferredLanguage column should be in the patch — the
    // tri-state semantics must NOT spuriously overwrite name/phone
    // when the caller didn't send them.
    expect(patch).toEqual({ preferredLanguage: 'es' });
  });

  it("accepts explicit null to clear the preference (back to follow-default)", async () => {
    // Simulate a user who previously chose Spanish and is now opting
    // back into "auto / follow my browser".
    mockGetUser.mockResolvedValueOnce({ ...TEST_USER, preferredLanguage: 'es' });

    const res = await patchProfile({ preferredLanguage: null });
    expect(res.status).toBe(200);

    expect(mockUpdateUser).toHaveBeenCalledTimes(1);
    const [, patch] = mockUpdateUser.mock.calls[0] as [number, Record<string, unknown>];
    expect(patch).toEqual({ preferredLanguage: null });
  });

  it('rejects an unknown locale code with a 400 and never touches storage', async () => {
    const res = await patchProfile({ preferredLanguage: 'xx' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    // No DB write should happen for invalid input — preventing the
    // email helper from later falling back to English on a value
    // we silently accepted.
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('omits preferredLanguage from the storage patch when the field was not provided', async () => {
    // Caller is just renaming themselves — the language column must
    // be left alone, not blanked out.
    const res = await patchProfile({ name: 'Renamed Tester' });
    expect(res.status).toBe(200);

    expect(mockUpdateUser).toHaveBeenCalledTimes(1);
    const [, patch] = mockUpdateUser.mock.calls[0] as [number, Record<string, unknown>];
    expect(patch).toEqual({ name: 'Renamed Tester' });
    expect(patch).not.toHaveProperty('preferredLanguage');
  });

  it("schema-level: .pick({phone}).extend({preferredLanguage:enum|null}) replaces — not merges with — the base schema's permissive z.string().nullable() (regression pin for .pick + .extend behaviour)", () => {
    // Without this contract, `updateUserSchemaBase`'s loose
    // `preferredLanguage: z.string().nullable()` could leak through
    // and quietly accept any string — which would defeat the whole
    // point of the allowlist.
    expect(profileUpdateSchema.safeParse({ preferredLanguage: 'fr' }).success).toBe(false);
    expect(profileUpdateSchema.safeParse({ preferredLanguage: '' }).success).toBe(false);
    expect(profileUpdateSchema.safeParse({ preferredLanguage: 'en' }).success).toBe(true);
    expect(profileUpdateSchema.safeParse({ preferredLanguage: null }).success).toBe(true);
    // Field stays optional — saving without it must not fail validation.
    expect(profileUpdateSchema.safeParse({}).success).toBe(true);
  });

  it("end-to-end round trip: PATCH preferredLanguage='es', then POST /change-password reads the stored value and dispatches the email with locale:'es'", async () => {
    // 1. The user (currently 'auto') updates their preferred
    //    language through the same account-settings endpoint the UI
    //    hits.
    const patchRes = await patchProfile({ preferredLanguage: 'es' });
    expect(patchRes.status).toBe(200);
    expect(mockUpdateUser).toHaveBeenCalledTimes(1);

    // 2. From here on, getUser() should reflect the persisted
    //    choice — that's what the change-password handler reads to
    //    pick the email locale. Simulate that without coupling to
    //    storage internals.
    mockGetUser.mockReset();
    mockGetUser.mockResolvedValue({ ...TEST_USER, preferredLanguage: 'es' });
    mockUpdateUser.mockClear();

    // 3. The same user changes their password.
    const cpRes = await postChangePassword({
      currentPassword: 'OriginalPw!2026',
      newPassword: 'BrandNewPw!2026XX',
    });
    expect(cpRes.status).toBe(200);

    await flushFireAndForget();

    // 4. The locale stored by step 1 must be the locale the
    //    notification helper is invoked with — otherwise the email
    //    would silently render in English regardless of preference.
    expect(mockSendPasswordChangedNotification).toHaveBeenCalledTimes(1);
    // The vi.fn() factory has no signature so its `calls` are typed
    // as `[]`; widen through `unknown` to read positional args.
    const call = mockSendPasswordChangedNotification.mock.calls[0] as unknown as unknown[];
    const ctx = call[2] as { locale?: string | null };
    expect(ctx.locale).toBe('es');
  });

  it('exports the same supported-language set as the bundled email translations', () => {
    // The whole point of sourcing the allowlist from
    // PASSWORD_CHANGED_I18N is that adding a translation
    // automatically widens the API. Pin that contract so a future
    // refactor can't accidentally hard-code the set.
    expect(new Set(SUPPORTED_PREFERRED_LANGUAGES)).toEqual(
      new Set(Object.keys(PASSWORD_CHANGED_I18N)),
    );
    // Sanity: at least the two we ship today.
    expect(SUPPORTED_PREFERRED_LANGUAGES).toContain('en');
    expect(SUPPORTED_PREFERRED_LANGUAGES).toContain('es');
  });
});
