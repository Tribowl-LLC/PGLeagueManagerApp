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
import type { AutopaySetupQuote } from '@/lib/autopay-setup';

type SubmitOpts = Parameters<typeof useBowlerPaymentSubmit>[0];

interface FakeResponse {
  ok: boolean;
  json: () => Promise<unknown>;
}

function jsonResponse(body: unknown, ok = true): Promise<FakeResponse> {
  const responseBody = ok && body && typeof body === 'object' && !('status' in body)
    ? { status: 'COMPLETED', ...body }
    : body;
  return Promise.resolve({ ok, json: () => Promise.resolve(responseBody) });
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

function makeAutopayQuote(immediateAmountMinor = 0): AutopaySetupQuote {
  return {
    quoteFingerprint: `lvautopayquote:v1:${'a'.repeat(64)}`,
    generatedAt: '2026-08-02T16:35:00.000Z',
    immediateAmountMinor,
    coveredOccurrences: [],
    firstAutomaticAt: '2026-08-02T16:40:00.000Z',
    firstAutomaticLocalDate: '2026-08-02',
    firstAutomaticAmountMinor: 2000,
    recurringAmountMinor: 2000,
    timezone: 'America/New_York',
    competitionStartTime: '12:40',
    resuming: false,
  };
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
    autopayQuote: makeAutopayQuote(),
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
  it('binds occurrence selections and the base quote fingerprint on saved-card submits', async () => {
    csrfFetchMock.mockResolvedValueOnce(await jsonResponse({ data: { id: 'pmt-1' } }));
    const occurrenceAllocations = [{ obligationId: '11111111-1111-4111-8111-111111111111', amountMinor: 2000 }];
    const occurrenceQuoteFingerprint = `lvquote:v1:${'a'.repeat(64)}`;

    await useBowlerPaymentSubmit(makeOptions({
      selectedSchedule: 'custom', occurrenceAllocations, occurrenceQuoteFingerprint,
    }))();

    const body = JSON.parse((csrfFetchMock.mock.calls[0]?.[1] as { body: string }).body);
    expect(body.occurrenceAllocations).toEqual(occurrenceAllocations);
    expect(body.occurrenceQuoteFingerprint).toBe(occurrenceQuoteFingerprint);
  });

  it('passes occurrence selections and the base quote fingerprint through new-card submits', async () => {
    createPaymentMock.mockResolvedValueOnce({ status: 'COMPLETED' });
    const occurrenceAllocations = [{ obligationId: '22222222-2222-4222-8222-222222222222', amountMinor: 2000 }];
    const occurrenceQuoteFingerprint = `lvquote:v1:${'b'.repeat(64)}`;

    await useBowlerPaymentSubmit(makeOptions({
      cardMode: 'new', card: makeCard(), selectedSchedule: 'custom',
      occurrenceAllocations, occurrenceQuoteFingerprint,
    }))();

    expect(createPaymentMock).toHaveBeenCalledWith(
      2000, expect.anything(), 'bowler-1', 'league-1', false, undefined, expect.any(String),
      occurrenceAllocations, occurrenceQuoteFingerprint,
    );
  });

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
    csrfFetchMock.mockResolvedValueOnce(await jsonResponse({ data: { immediateAmountMinor: 0 } }));

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
    expect(description).toBe('Your card has been saved and weekly auto-pay is now active for the next unpaid league occurrence.');
    expect(description).not.toMatch(/Paid \$/);
    expect(description).not.toMatch(/today/);
    expect(description).not.toMatch(/selectedSchedule/);
  });

  it('sends combined auto-pay only to the server-authoritative setup endpoint', async () => {
    csrfFetchMock.mockResolvedValueOnce(await jsonResponse({ data: { immediateAmountMinor: 16000 } }));

    const submit = useBowlerPaymentSubmit(
      makeOptions({
        selectedSchedule: 'weekly',
        cardMode: 'saved',
        selectedSavedCardId: 'card-1',
        weeklyFee: 2000,
        additionalBowlerIds: [42, 43],
        autopayQuote: makeAutopayQuote(16000),
        financials: {
          fullSeasonAmount: 30000,
          remainingBalance: 30000,
          amountPastDue: 6000,
        },
        calculateTotalAmount: () => 2000,
      }),
    );

    await submit();

    expect(csrfFetchMock).toHaveBeenCalledTimes(1);
    const [setupUrl, setupInit] = csrfFetchMock.mock.calls[0];
    expect(setupUrl).toBe('/api/payment-schedules/setup');
    const setupBody = JSON.parse((setupInit as { body: string }).body);
    expect(setupBody).not.toHaveProperty('amount');
    expect(setupBody).not.toHaveProperty('payees');
    expect(setupBody).not.toHaveProperty('nextPaymentDate');
    expect(setupBody.additionalBowlerIds).toEqual([42, 43]);
    expect(setupBody.quoteFingerprint).toBe(makeAutopayQuote(16000).quoteFingerprint);

    const { title, description } = lastToast();
    expect(title).toBe('Auto-Pay Activated');
    expect(description).toBe(
      'Paid $160.00 today and weekly auto-pay is now active for the next unpaid league occurrence.',
    );
  });

  it('surfaces a setup failure without falling back to a client-orchestrated charge', async () => {
    csrfFetchMock.mockResolvedValueOnce(
      await jsonResponse({ error: { message: 'Card declined', code: 'CARD_DECLINED' } }, false),
    );

    const submit = useBowlerPaymentSubmit(
      makeOptions({
        selectedSchedule: 'weekly',
        cardMode: 'saved',
        selectedSavedCardId: 'card-1',
        autopayQuote: makeAutopayQuote(8000),
        financials: { fullSeasonAmount: 30000, remainingBalance: 30000, amountPastDue: 6000 },
        calculateTotalAmount: () => 2000,
      }),
    );

    await submit();

    expect(csrfFetchMock).toHaveBeenCalledTimes(1);
    expect(csrfFetchMock.mock.calls[0]?.[0]).toBe('/api/payment-schedules/setup');
    const { title, variant } = lastToast();
    expect(variant).toBe('destructive');
    expect(title).toBe('Payment Failed');
  });

  it('shows the auto-pay with-balance toast that splits the past-due charge from the schedule', async () => {
    csrfFetchMock.mockResolvedValueOnce(await jsonResponse({ data: { immediateAmountMinor: 8000 } }));

    const submit = useBowlerPaymentSubmit(
      makeOptions({
        selectedSchedule: 'weekly',
        autopayQuote: makeAutopayQuote(8000),
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
      'Paid $80.00 today and weekly auto-pay is now active for the next unpaid league occurrence.',
    );
    expect(description).not.toBe('Your card has been saved and weekly auto-pay is now active for the next unpaid league occurrence.');
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
