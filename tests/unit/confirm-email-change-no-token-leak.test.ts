/**
 * Regression test for task #396 — sibling of
 * `tests/unit/csrf-no-token-leak.test.ts` covering
 * `POST /api/account/confirm-email-change` in
 * `server/routes/account.ts`.
 *
 * The endpoint authenticates the caller via a single-use, expiring
 * email-change confirmation token from the request body. That token
 * is the only auth factor (the route is unauthenticated — anyone
 * with the link can complete the swap) so it must never be logged
 * at any level: an operator who turns on `LOG_LEVEL=debug` for an
 * incident must not end up shipping live, replayable confirmation
 * tokens to the production log sink.
 *
 * Strategy mirrors `tests/unit/auth-no-token-leak.test.ts`: mount
 * the real router on an isolated express app with all external
 * deps mocked, drive every reject branch with known token bytes,
 * and assert via the shared helper that no captured log line
 * contains those bytes.
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
import {
  assertNoTokenLeak as sharedAssertNoTokenLeak,
  type CapturedLogLine,
} from '../helpers/no-token-leak';

const captured: CapturedLogLine[] = [];

function record(level: string) {
  return (message: string, ...args: unknown[]) => {
    const tail = args.length > 0 ? ' ' + JSON.stringify(args) : '';
    captured.push({ level, line: `${message}${tail}` });
  };
}

vi.mock('../../server/logger', () => ({
  createLogger: () => ({
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    debug: record('debug'),
  }),
}));

// --- External dep mocks. Hoisted by vitest. ----------------------

// Controllable transaction result. The handler does
// `await db.transaction(async tx => ...)` and inspects the returned
// `outcome.kind`. We let each test set what the handler "sees".
type ConfirmOutcome =
  | { kind: 'ok'; user: { id: number; email: string }; requestId?: number }
  | { kind: 'invalid' }
  | { kind: 'consumed' }
  | { kind: 'expired' }
  | { kind: 'user_gone' };

const txState: { outcome: ConfirmOutcome | (() => Promise<never>) } = {
  outcome: { kind: 'invalid' },
};

vi.mock('../../server/db', () => ({
  db: {
    transaction: async (_fn: unknown) => {
      const o = txState.outcome;
      if (typeof o === 'function') {
        return await o();
      }
      return o;
    },
  },
}));

vi.mock('../../server/storage', () => ({
  storage: {
    getEmailChangeRequestByTokenHash: vi.fn(async () => null),
    consumeEmailChangeRequest: vi.fn(async () => undefined),
  },
}));

vi.mock('../../server/services/payment-customer-sync', () => ({
  syncBowlerForUser: vi.fn(async () => 'not_applicable'),
}));

vi.mock('../../server/services/email', () => ({
  sendDeletionRequestNotification: vi.fn(async () => true),
  sendEmailChangeConfirmation: vi.fn(async () => true),
  sendEmailChangeNotification: vi.fn(async () => true),
  sendPasswordChangedNotification: vi.fn(async () => true),
  getBaseUrl: () => 'https://test.example',
}));

vi.mock('../../server/auth', () => ({
  hashPassword: vi.fn(async (pw: string) => `hashed:${pw}`),
  destroyOtherSessionsForUser: vi.fn(async () => 0),
}));

const mockLogin = vi.fn((_user: unknown, done: (error: unknown) => void) => done(null));
const mockDestroyCurrentSession = vi.fn((done: (error?: unknown) => void) => done());

vi.mock('../../server/middleware/auth', () => ({
  requireSystemAdmin: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

vi.mock('express-rate-limit', () => ({
  default: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  ipKeyGenerator: (ip: string) => ip,
}));

vi.mock('../../server/utils/rate-limit-store', () => ({
  createSharedRateLimitStore: () => undefined,
}));

vi.mock('../../server/storage/admin-email-change-audits', () => ({
  recordAdminEmailChangeAudit: vi.fn(async () => undefined),
}));

vi.mock('../../server/config', () => ({ isDev: true, env: {} }));

// Now import the real router with all of its deps mocked.
const accountRouter = (await import('../../server/routes/account')).default;

// --- Test express app harness ------------------------------------

let server: Server;
let baseUrl: string;
let sessionUser: { id: number } | undefined;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.defineProperty(req, 'ip', { value: '198.51.100.42', configurable: true });
    Object.assign(req, {
      user: sessionUser,
      login: (user: unknown, done: (error: unknown) => void) => mockLogin(user, done),
      session: { destroy: (done: (error?: unknown) => void) => mockDestroyCurrentSession(done) },
    });
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
  captured.length = 0;
  txState.outcome = { kind: 'invalid' };
  sessionUser = undefined;
  mockLogin.mockClear();
  mockDestroyCurrentSession.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

// 32-byte hex confirmation token (matches the
// `randomBytes(32).toString('hex')` shape the issuer uses).
const CONFIRM_TOKEN =
  'deadbeefcafebabe1234567890abcdefdeadbeefcafebabe1234567890abcdef';

function assertNoConfirmTokenLeak() {
  sharedAssertNoTokenLeak(captured, { full: [CONFIRM_TOKEN] });
}

async function postConfirm(token: unknown) {
  return fetch(`${baseUrl}/api/account/confirm-email-change`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(token === undefined ? {} : { token }),
  });
}

describe('POST /api/account/confirm-email-change does not leak the token to logs', () => {
  it('rejects when the schema rejects an empty body without leaking anything', async () => {
    const res = await postConfirm(undefined);
    expect(res.status).toBe(400);
    assertNoConfirmTokenLeak();
  });

  it('rejects an unknown token (kind=invalid) without leaking the token bytes', async () => {
    txState.outcome = { kind: 'invalid' };
    const res = await postConfirm(CONFIRM_TOKEN);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(res.status).toBe(400);
    expect(body.error?.code).toBe('INVALID_TOKEN');
    assertNoConfirmTokenLeak();
  });

  it('rejects an already-consumed token (kind=consumed) without leaking the token bytes', async () => {
    txState.outcome = { kind: 'consumed' };
    const res = await postConfirm(CONFIRM_TOKEN);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(res.status).toBe(400);
    expect(body.error?.code).toBe('TOKEN_CONSUMED');
    assertNoConfirmTokenLeak();
  });

  it('rejects an expired token (kind=expired) without leaking the token bytes', async () => {
    txState.outcome = { kind: 'expired' };
    const res = await postConfirm(CONFIRM_TOKEN);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(res.status).toBe(400);
    expect(body.error?.code).toBe('TOKEN_EXPIRED');
    assertNoConfirmTokenLeak();
  });

  it('rejects when the user row vanished mid-transaction without leaking the token bytes', async () => {
    txState.outcome = { kind: 'user_gone' };
    const res = await postConfirm(CONFIRM_TOKEN);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(res.status).toBe(404);
    expect(body.error?.code).toBe('USER_NOT_FOUND');
    assertNoConfirmTokenLeak();
  });

  it('refreshes only the current target user session after an email rotation', async () => {
    sessionUser = { id: 7 };
    txState.outcome = {
      kind: 'ok',
      user: { id: 7, email: 'new-address@vitest.local' },
      requestId: 42,
    };

    const res = await postConfirm(CONFIRM_TOKEN);
    expect(res.status).toBe(200);
    expect(mockLogin).toHaveBeenCalledWith(
      expect.objectContaining({ id: 7, email: 'new-address@vitest.local' }),
      expect.any(Function),
    );
  });

  it.each([
    {
      stage: 'session regeneration',
      error: 'synthetic session regeneration failure',
    },
    {
      stage: 'session save',
      error: 'synthetic session save failure',
    },
  ])('returns a completed change with requiresLogin when Passport $stage fails', async ({ error }) => {
    sessionUser = { id: 7 };
    txState.outcome = {
      kind: 'ok',
      user: { id: 7, email: 'new-address@vitest.local' },
      requestId: 42,
    };
    mockLogin.mockImplementationOnce((_user, done) => {
      done(new Error(error));
    });

    const res = await postConfirm(CONFIRM_TOKEN);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      success: boolean;
      data?: { email?: string; requiresLogin?: boolean };
    };
    expect(body.success).toBe(true);
    expect(body.data?.email).toBe('new-address@vitest.local');
    expect(body.data?.requiresLogin).toBe(true);
    expect(mockDestroyCurrentSession).toHaveBeenCalledTimes(1);
    // The logged event must remain free of the raw confirmation token.
    assertNoConfirmTokenLeak();
  });

  it('does not leak the token even when the transaction throws (catch path)', async () => {
    // The catch logs `log.error('Error confirming email change:', error)`.
    // Synthesized error intentionally does NOT include the token, so
    // the test is a forward-looking guard against a future change
    // that adds e.g. `{ token }` to the error context.
    txState.outcome = () =>
      Promise.reject(new Error('synthetic transaction failure (no token inside)'));
    const res = await postConfirm(CONFIRM_TOKEN);
    expect(res.status).toBe(500);
    assertNoConfirmTokenLeak();
  });
});
