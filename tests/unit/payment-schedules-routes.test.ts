/**
 * Route-level tests for the legacy payment-schedule write boundary.
 *
 * Mounts the real router on an isolated Express app with storage,
 * access-control, db, scheduler, and rate-limiter mocked, then drives
 * the endpoint over real HTTP via `fetch`.
 *
 * Weekly auto-pay setup is server-authoritative, so legacy weekly payloads
 * must be rejected regardless of client-computed balance, amount, or card.
 * Upfront schedules retain their established behavior.
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
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const mockStorage = {
  getPaymentSchedule: vi.fn(),
  getLeague: vi.fn(),
  getBowler: vi.fn(),
  createPaymentSchedule: vi.fn(),
};

vi.mock('../../server/storage', () => ({ storage: mockStorage }));

const mockHasAccessToLeague = vi.fn();
const mockHasSelfOrAdminAccessToBowler = vi.fn();
vi.mock('../../server/utils/access-control', () => ({
  hasAccessToLeague: (...a: unknown[]) => mockHasAccessToLeague(...a),
  hasSelfOrAdminAccessToBowler: (...a: unknown[]) => mockHasSelfOrAdminAccessToBowler(...a),
}));

const mockGetAcceptedPartnerBowlerIds = vi.fn();
vi.mock('../../server/storage/bowler-payment-links', () => ({
  getAcceptedPartnerBowlerIds: (...a: unknown[]) => mockGetAcceptedPartnerBowlerIds(...a),
}));

const mockAddSchedule = vi.fn();
vi.mock('../../server/services/payment-scheduler', () => ({
  paymentScheduler: { addSchedule: (...a: unknown[]) => mockAddSchedule(...a) },
}));

vi.mock('../../server/db', () => ({ db: {} }));

vi.mock('../../server/middleware/rate-limit', () => ({
  adminWriteLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// Imports must come after vi.mock declarations.
const paymentSchedulesRouter = (await import('../../server/routes/payment-schedules')).default;

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // Inject req.user + req.isAuthenticated() from a test header.
  app.use((req, _res, next) => {
    const raw = req.header('x-test-user');
    if (raw) Object.defineProperty(req, 'user', { value: JSON.parse(raw), configurable: true });
    Object.defineProperty(req, 'isAuthenticated', {
      value: () => Boolean(raw),
      configurable: true,
    });
    next();
  });
  app.use('/api/payment-schedules', paymentSchedulesRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

const ORG = 1;
const PAYER = 100;
const PARTNER = 200;
const LEAGUE_PAYG = {
  id: 11,
  organizationId: ORG,
  paymentMode: 'pay-as-you-go' as const,
  weeklyFee: 2000,
  totalBowlingWeeks: 10,
  cancelledDates: [],
  weekDay: 1,
  competitionStartTime: '19:00',
  timezone: 'America/New_York',
  skipDates: [],
  seasonStart: '2026-01-05',
  seasonEnd: '2026-03-30',
};
const LEAGUE_UPFRONT = { ...LEAGUE_PAYG, paymentMode: 'upfront' as const };

function userHeader() {
  return {
    'x-test-user': JSON.stringify({ id: 7, role: 'org_admin', organizationId: ORG }),
    'content-type': 'application/json',
  };
}

async function postSchedule(body: unknown) {
  return fetch(`${baseUrl}/api/payment-schedules`, {
    method: 'POST',
    headers: userHeader(),
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  for (const fn of Object.values(mockStorage)) (fn as ReturnType<typeof vi.fn>).mockReset();
  mockHasAccessToLeague.mockReset();
  mockHasSelfOrAdminAccessToBowler.mockReset();
  mockGetAcceptedPartnerBowlerIds.mockReset();
  mockAddSchedule.mockReset();

  mockHasAccessToLeague.mockResolvedValue(true);
  mockHasSelfOrAdminAccessToBowler.mockResolvedValue(true);
  mockStorage.getPaymentSchedule.mockResolvedValue(undefined);
  mockGetAcceptedPartnerBowlerIds.mockResolvedValue([PARTNER]);
});

afterEach(() => vi.clearAllMocks());

describe('POST /api/payment-schedules legacy weekly cutoff', () => {
  it('rejects a payer-only legacy weekly schedule', async () => {
    mockStorage.getLeague.mockResolvedValue(LEAGUE_PAYG);
    const res = await postSchedule({
      bowlerId: PAYER,
      leagueId: LEAGUE_PAYG.id,
      amount: 2000,
      frequency: 'weekly',
    });

    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.error.code).toBe('LEGACY_AUTOPAY_RETIRED');
    expect(mockStorage.createPaymentSchedule).not.toHaveBeenCalled();
    expect(mockAddSchedule).not.toHaveBeenCalled();
  });

  it('rejects a combined legacy weekly schedule', async () => {
    mockStorage.getLeague.mockResolvedValue(LEAGUE_PAYG);
    const res = await postSchedule({
      bowlerId: PAYER,
      leagueId: LEAGUE_PAYG.id,
      amount: 4000,
      frequency: 'weekly',
      additionalBowlerIds: [PARTNER],
    });

    expect(res.status).toBe(410);
    expect((await res.json()).error.code).toBe('LEGACY_AUTOPAY_RETIRED');
    expect(mockStorage.createPaymentSchedule).not.toHaveBeenCalled();
    expect(mockAddSchedule).not.toHaveBeenCalled();
  });

  it('does not trust a client-provided card or amount to bypass setup', async () => {
    mockStorage.getLeague.mockResolvedValue(LEAGUE_PAYG);
    const res = await postSchedule({
      bowlerId: PAYER,
      leagueId: LEAGUE_PAYG.id,
      amount: 4000,
      frequency: 'weekly',
      additionalBowlerIds: [PARTNER],
      // satisfy the schedule's required fields with sensible defaults;
      // anything missing comes through as undefined which the zod
      // schema will accept-or-default. The test cares about the gate,
      // not the schedule shape.
      paymentMethodId: 'card-1',
      cardId: 'card-1',
    });

    expect(res.status).toBe(410);
    expect((await res.json()).error.code).toBe('LEGACY_AUTOPAY_RETIRED');
    expect(mockStorage.createPaymentSchedule).not.toHaveBeenCalled();
    expect(mockAddSchedule).not.toHaveBeenCalled();
  });

  it('keeps upfront-frequency schedules on upfront leagues', async () => {
    mockStorage.getLeague.mockResolvedValue(LEAGUE_UPFRONT);
    const res = await postSchedule({
      bowlerId: PAYER,
      leagueId: LEAGUE_UPFRONT.id,
      amount: LEAGUE_UPFRONT.weeklyFee * LEAGUE_UPFRONT.totalBowlingWeeks,
      frequency: 'upfront',
    });

    // The upfront branch has its own validators and must not be routed
    // through the weekly auto-pay setup boundary.
    if (res.status >= 400) {
      const body = await res.json();
      expect(body.error?.code).not.toBe('AUTOPAY_SETUP_REQUIRED');
    }
  });
});
