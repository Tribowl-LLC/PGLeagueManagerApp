import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Bowler, League } from '@shared/schema';

const {
  toastMock,
  csrfFetchMock,
  invalidateQueriesMock,
  createPaymentMock,
  tokenizeCardMock,
} = vi.hoisted(() => ({
  toastMock: vi.fn(),
  csrfFetchMock: vi.fn(),
  invalidateQueriesMock: vi.fn(),
  createPaymentMock: vi.fn(),
  tokenizeCardMock: vi.fn(),
}));

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return { ...actual, useCallback: <T>(fn: T): T => fn };
});

// The hook calls `useLocation()` from wouter so it can pass `navigate`
// into `providerNotConfiguredToast` in its catch block. This test invokes
// the hook as a plain function (the `useCallback` mock above strips React's
// hook context), so we likewise neutralize wouter's hook here. Without
// this, wouter's real `useLocation` triggers React's "Invalid hook call"
// guard and every test in this file fails before reaching its assertion.
vi.mock('wouter', () => ({
  useLocation: () => ['/test', vi.fn()] as const,
}));

vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: toastMock, dismiss: vi.fn(), toasts: [] }),
}));

vi.mock('@/lib/queryClient', () => ({
  csrfFetch: csrfFetchMock,
  queryClient: { invalidateQueries: invalidateQueriesMock },
}));

vi.mock('@/lib/square', () => ({
  createPayment: createPaymentMock,
  tokenizeCard: tokenizeCardMock,
}));

// Mock the toast helper so the test can pin the exact `provider`
// argument the hook forwards (rather than constructing the JSX
// `ToastAction` and asserting on serialized output). This is the
// real wiring contract for #610: the hook MUST pass the location's
// active provider, not let the helper's default ("square") win.
const { providerNotConfiguredToastMock } = vi.hoisted(() => ({
  providerNotConfiguredToastMock: vi.fn(),
}));

vi.mock('@/lib/provider-not-configured', async () => {
  const actual = await vi.importActual<typeof import('../../client/src/lib/provider-not-configured')>(
    '../../client/src/lib/provider-not-configured',
  );
  return {
    ...actual,
    providerNotConfiguredToast: (
      opts: Parameters<typeof actual.providerNotConfiguredToast>[0],
    ) => {
      providerNotConfiguredToastMock(opts);
      // Return a sentinel so the hook's `toast(...)` call still has a
      // real-shaped object to forward and the test can assert on the
      // toast-mock's `title` if it wants to.
      return {
        title: "Square isn't connected for this location",
        variant: 'destructive' as const,
      };
    },
  };
});

import { useBowlerPaymentSubmit } from '@/hooks/use-bowler-payment-submit';

type SubmitOpts = Parameters<typeof useBowlerPaymentSubmit>[0];

interface FakeResponse {
  ok: boolean;
  json: () => Promise<unknown>;
}

function jsonResponse(body: unknown, ok = true): Promise<FakeResponse> {
  return Promise.resolve({ ok, json: () => Promise.resolve(body) });
}

function makeLeague(paymentMode: 'pay-as-you-go' | 'upfront' = 'pay-as-you-go'): League {
  return { id: 'league-1', locationId: 99, paymentMode } as unknown as League;
}

function makeBowler(): Bowler {
  return { id: 'bowler-1' } as unknown as Bowler;
}

function makeCard(): NonNullable<SubmitOpts['card']> {
  // The hook only checks `card` is truthy at the cardMode==='new' gate;
  // the real shape doesn't matter because tokenizeCard is mocked.
  return { token: 'unused' } as unknown as NonNullable<SubmitOpts['card']>;
}

function makeOptions(overrides: Partial<SubmitOpts> = {}): SubmitOpts {
  const base: SubmitOpts = {
    league: makeLeague(),
    bowler: makeBowler(),
    weeklyFee: 2000,
    card: null,
    cardMode: 'saved',
    selectedSavedCardId: 'card-1',
    selectedSchedule: 'weekly',
    storeCard: false,
    financials: {
      fullSeasonAmount: 30000,
      remainingBalance: 30000,
      amountPastDue: 0,
    },
    calculateTotalAmount: () => 2000,
    setIsSubmitting: vi.fn(),
    setShowPaymentSetup: vi.fn(),
  };
  return { ...base, ...overrides };
}

interface ToastArg {
  title: string;
  description: string;
  variant?: string;
}

function lastToast(): ToastArg {
  const calls = toastMock.mock.calls;
  if (calls.length === 0) throw new Error('expected toast to have been called');
  return calls[calls.length - 1][0] as ToastArg;
}

beforeEach(() => {
  toastMock.mockReset();
  csrfFetchMock.mockReset();
  invalidateQueriesMock.mockReset();
  createPaymentMock.mockReset();
  tokenizeCardMock.mockReset();
  providerNotConfiguredToastMock.mockReset();
});

describe('useBowlerPaymentSubmit success toasts', () => {
  it('shows the custom one-time payment success toast with formatted amount', async () => {
    csrfFetchMock.mockResolvedValueOnce(await jsonResponse({ data: { id: 'pmt-1' } }));

    const submit = useBowlerPaymentSubmit(
      makeOptions({
        league: makeLeague('pay-as-you-go'),
        selectedSchedule: 'custom',
        calculateTotalAmount: () => 5000,
      }),
    );

    await submit();

    expect(toastMock).toHaveBeenCalledTimes(1);
    const { title, description, variant } = lastToast();
    expect(variant).toBeUndefined();
    expect(title).toBe('Payment Successful');
    expect(description).toBe('Your payment of $50.00 has been processed.');
    expect(description).not.toMatch(/selectedSchedule/);
  });

  it('shows the upfront full-season success toast', async () => {
    csrfFetchMock.mockResolvedValueOnce(await jsonResponse({ data: { id: 'pmt-1' } }));

    const submit = useBowlerPaymentSubmit(
      makeOptions({
        league: makeLeague('upfront'),
      }),
    );

    await submit();

    expect(toastMock).toHaveBeenCalledTimes(1);
    const { title, description } = lastToast();
    expect(title).toBe('Payment Successful');
    expect(description).toBe(
      'Your full season payment of $300.00 has been processed.',
    );
  });

  it('charges and labels only the remaining balance for an upfront league after a legacy partial payment', async () => {
    csrfFetchMock.mockResolvedValueOnce(await jsonResponse({ data: { id: 'pmt-1' } }));

    const submit = useBowlerPaymentSubmit(
      makeOptions({
        league: makeLeague('upfront'),
        financials: {
          fullSeasonAmount: 30000,
          remainingBalance: 25000,
          amountPastDue: 25000,
        },
      }),
    );

    await submit();

    expect(csrfFetchMock).toHaveBeenCalledWith(
      '/api/payments-provider/payments',
      expect.objectContaining({
        body: expect.stringContaining('"amount":25000'),
      }),
    );
    expect(lastToast().description).toBe(
      'Your remaining season balance of $250.00 has been processed.',
    );
  });

  it('shows the auto-pay no-balance toast that does not mention a charge today', async () => {
    csrfFetchMock.mockResolvedValueOnce(await jsonResponse({ ok: true }));

    const submit = useBowlerPaymentSubmit(
      makeOptions({
        selectedSchedule: 'weekly',
        financials: {
          fullSeasonAmount: 30000,
          remainingBalance: 30000,
          amountPastDue: 0,
        },
        calculateTotalAmount: () => 2000,
      }),
    );

    await submit();

    expect(toastMock).toHaveBeenCalledTimes(1);
    const { title, description } = lastToast();
    expect(title).toBe('Auto-Pay Activated');
    expect(description).toBe('Your card has been saved and weekly auto-pay is now active.');
    expect(description).not.toMatch(/Paid \$/);
    expect(description).not.toMatch(/today/);
    expect(description).not.toMatch(/selectedSchedule/);
  });

  // Task #715: combined weekly auto-pay setup must clear every
  // included bowler's past-due balance up front. The immediate charge
  // is Σ(amountPastDue + weeklyFee) per included bowler, routed
  // through the combined-payments endpoint so one charge writes N+1
  // per-bowler rows. Only on success does the schedule POST happen.
  it('combined autopay with past-due charges Σ(pastDue+weeklyFee) via combined-payments before scheduling', async () => {
    csrfFetchMock
      // 1) immediate combined charge
      .mockResolvedValueOnce(await jsonResponse({ data: { id: 'pmt-1' } }))
      // 2) schedule create
      .mockResolvedValueOnce(await jsonResponse({ ok: true }));

    const submit = useBowlerPaymentSubmit(
      makeOptions({
        selectedSchedule: 'weekly',
        cardMode: 'saved',
        selectedSavedCardId: 'card-1',
        weeklyFee: 2000,
        additionalBowlerIds: [42, 43],
        partnerPastDueByBowlerId: { 42: 4000, 43: 0 },
        financials: {
          fullSeasonAmount: 30000,
          remainingBalance: 30000,
          amountPastDue: 6000,
        },
        calculateTotalAmount: () => 2000,
      }),
    );

    await submit();

    // First csrfFetch: combined-payments with per-bowler payees that
    // each charge `amountPastDue + weeklyFee`. Self: 6000+2000,
    // partner-42: 4000+2000, partner-43: 0+2000. Total 16000.
    const [combinedUrl, combinedInit] = csrfFetchMock.mock.calls[0];
    expect(combinedUrl).toBe('/api/payments-provider/combined-payments');
    const combinedBody = JSON.parse((combinedInit as { body: string }).body);
    expect(combinedBody.amount).toBe(16000);
    expect(combinedBody.payees).toEqual([
      { bowlerId: 'bowler-1', amount: 8000 },
      { bowlerId: 42, amount: 6000 },
      { bowlerId: 43, amount: 2000 },
    ]);
    expect(combinedBody.sourceId).toBe('card-1');

    // Second csrfFetch: schedule create with the recurring weeklyFee
    // (NOT the catch-up amount) and the combined partner ids.
    const [scheduleUrl, scheduleInit] = csrfFetchMock.mock.calls[1];
    expect(scheduleUrl).toBe('/api/payment-schedules');
    const scheduleBody = JSON.parse((scheduleInit as { body: string }).body);
    expect(scheduleBody.amount).toBe(2000);
    expect(scheduleBody.additionalBowlerIds).toEqual([42, 43]);

    const { title, description } = lastToast();
    expect(title).toBe('Auto-Pay Activated');
    expect(description).toBe(
      'Paid $160.00 today and weekly auto-pay is now active for future weeks.',
    );
  });

  // Task #715: when the immediate catch-up charge fails, NO schedule
  // is created. The hook surfaces a Payment Failed toast and the
  // schedule POST never fires.
  it('aborts schedule creation when the immediate past-due charge fails', async () => {
    csrfFetchMock.mockResolvedValueOnce(
      await jsonResponse({ error: { message: 'Card declined', code: 'CARD_DECLINED' } }, false),
    );

    const submit = useBowlerPaymentSubmit(
      makeOptions({
        selectedSchedule: 'weekly',
        cardMode: 'saved',
        selectedSavedCardId: 'card-1',
        financials: { fullSeasonAmount: 30000, remainingBalance: 30000, amountPastDue: 6000 },
        calculateTotalAmount: () => 2000,
      }),
    );

    await submit();

    // Exactly one POST: the failed immediate charge. The schedule POST
    // never fires because the throw aborts before it.
    expect(csrfFetchMock).toHaveBeenCalledTimes(1);
    const { title, variant } = lastToast();
    expect(variant).toBe('destructive');
    expect(title).toBe('Payment Failed');
  });

  it('shows the auto-pay with-balance toast that splits the past-due charge from the schedule', async () => {
    csrfFetchMock
      .mockResolvedValueOnce(await jsonResponse({ data: { id: 'pmt-1' } }))
      .mockResolvedValueOnce(await jsonResponse({ ok: true }));

    const submit = useBowlerPaymentSubmit(
      makeOptions({
        selectedSchedule: 'weekly',
        financials: {
          fullSeasonAmount: 30000,
          remainingBalance: 30000,
          amountPastDue: 6000,
        },
        calculateTotalAmount: () => 8000,
      }),
    );

    await submit();

    expect(toastMock).toHaveBeenCalledTimes(1);
    const { title, description } = lastToast();
    expect(title).toBe('Auto-Pay Activated');
    expect(description).toBe(
      'Paid $80.00 today and weekly auto-pay is now active for future weeks.',
    );
    expect(description).not.toBe('Your card has been saved and weekly auto-pay is now active.');
  });
});

// Pin the Square-only provider-not-configured behavior.
describe('useBowlerPaymentSubmit PROVIDER_NOT_CONFIGURED toast (#610)', () => {
  // Helper: drive the upfront-with-new-card branch so the catch block
  // sees a structured PROVIDER_NOT_CONFIGURED error. After task #672
  // the upfront new-card flow charges immediately via `createPayment`
  // (no forced save-card), so we mock that to throw an
  // ApiErrorLike with the PROVIDER_NOT_CONFIGURED code.
  async function triggerNotConfigured() {
    const err = new Error('Provider not connected') as Error & { code?: string; status?: number };
    err.code = 'PROVIDER_NOT_CONFIGURED';
    err.status = 422;
    createPaymentMock.mockRejectedValueOnce(err);

    const submit = useBowlerPaymentSubmit(
      makeOptions({
        league: makeLeague('upfront'),
        cardMode: 'new',
        card: makeCard(),
        selectedSavedCardId: '',
      }),
    );
    await submit();
  }

  it('uses the Square-only provider-not-configured toast', async () => {

    await triggerNotConfigured();

    // Pin the wiring contract directly.
    expect(providerNotConfiguredToastMock).toHaveBeenCalledTimes(1);
    expect(providerNotConfiguredToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ locationId: 99 }),
    );

    const { title, variant } = lastToast();
    expect(variant).toBe('destructive');
    expect(title).toBe("Square isn't connected for this location");
  });

});
