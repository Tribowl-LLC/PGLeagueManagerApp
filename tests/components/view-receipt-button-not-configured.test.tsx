/**
 * Component test for the PROVIDER_NOT_CONFIGURED branch in
 * <ViewReceiptButton /> (task #595; pins the deep-link added when
 * receipt-related buttons started forwarding the location id to
 * `providerNotConfiguredToast`).
 *
 * Background: when an admin clicks "View Receipt" on a card row
 * whose owning location no longer has Square credentials,
 * the lazy-backfill endpoint (`GET /api/payments-provider/payments
 * /:id/receipt`) returns 422 PROVIDER_NOT_CONFIGURED. The button
 * used to surface that as a generic "Receipt unavailable" toast
 * with no way to fix it. It now fires the shared actionable toast,
 * and — critically — passes the row's `locationId` so the
 * "Open Settings" action deep-links to
 * `/integrations?location=<id>` instead of the bare `/integrations`
 * page (which would force the admin to re-pick the location).
 *
 * `tests/components/provider-not-configured-toast.test.tsx`
 * already covers the helper itself; this file pins the
 * `view-receipt-button.tsx` -> helper wiring so a future refactor
 * can't silently drop the location id and revert to the generic
 * link.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { clearProviderConfigCache } from '@/hooks/use-payment-provider';

// Several Radix primitives reach for ResizeObserver via
// `react-use-size` — jsdom doesn't ship one, so polyfill a no-op
// before any component code runs.
if (typeof globalThis.ResizeObserver === 'undefined') {
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ResizeObserver = NoopResizeObserver;
}

import type { Payment } from '@shared/schema';

// Hoisted so the queryClient mock factory (which runs before module
// init) can reference the same fn the test body asserts against.
const { csrfFetchMock } = vi.hoisted(() => ({ csrfFetchMock: vi.fn() }));

vi.mock('@/lib/queryClient', async () => {
  const actual = await vi.importActual<typeof import('../../client/src/lib/queryClient')>(
    '../../client/src/lib/queryClient',
  );
  return {
    ...actual,
    csrfFetch: csrfFetchMock,
    queryClient: {
      invalidateQueries: vi.fn(),
    },
  };
});

const { navigateMock } = vi.hoisted(() => ({ navigateMock: vi.fn() }));

vi.mock('wouter', async () => {
  const actual = await vi.importActual<typeof import('wouter')>('wouter');
  return {
    ...actual,
    useLocation: () => ['/', navigateMock],
  };
});

import { ViewReceiptButton } from '@/components/view-receipt-button';
import { Toaster } from '@/components/ui/toaster';

// A card-paid row with NO cached receiptUrl but WITH a provider
// payment id — this is the only shape that triggers the lazy
// backfill fetch (and therefore the PROVIDER_NOT_CONFIGURED branch
// we want to exercise). Schema-shaped so a future Payment field
// addition doesn't get silently papered over with a cast.
const PAYMENT: Payment = {
  id: 101,
  bowlerId: 1,
  leagueId: 7,
  amount: 2500,
  lineageAmount: null,
  prizeFundAmount: null,
  weekOf: '2025-01-06',
  status: 'paid',
  type: 'square',
  checkNumber: null,
  combinedChargeGroupId: null,
  paymentOperationId: null,
  paymentOperationAllocationIndex: null,
  providerPaymentId: 'sq_pay_abc',
  idempotencyKey: null,
  squareRefundId: null,
  refundReason: null,
  refundedAt: null,
  disputeId: null,
  disputedAt: null,
  receiptUrl: null,
  receiptNumber: null,
  receiptEmailMissing: false,
  notes: null,
  paidByUserId: null,
  createdAt: '2025-01-06T00:00:00.000Z',
};

// Capture the original global fetch so per-test overrides for the
// `usePaymentProvider` config endpoint can be torn down cleanly.
const originalFetch = global.fetch;

function mockProviderConfigFetch(_provider: 'square') {
  global.fetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/payments-provider/config')) {
      return new Response(
        JSON.stringify({ providerConfigured: false }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response('{}', { status: 200 });
  });
}

beforeEach(() => {
  csrfFetchMock.mockReset();
  navigateMock.mockReset();
  // The `usePaymentProvider` cache is module-level; without a clear
  // one test could be poisoned by a prior config fetch.
  clearProviderConfigCache();
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe('<ViewReceiptButton /> — PROVIDER_NOT_CONFIGURED branch (#595)', () => {
  it('fires the actionable toast and deep-links Open Settings to /integrations?location=<id>', async () => {
    csrfFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: false,
          error: { code: 'PROVIDER_NOT_CONFIGURED', message: 'Square not connected' },
        }),
        { status: 422, headers: { 'content-type': 'application/json' } },
      ),
    );

    const user = userEvent.setup();
    render(
      <>
        <ViewReceiptButton payment={PAYMENT} variant="link" locationId={42} />
        <Toaster />
      </>,
    );

    // The button renders as "Look up" because there is no cached
    // receipt URL — this is the variant that triggers the backfill
    // fetch (and therefore the not-configured branch).
    await user.click(screen.getByRole('button', { name: /look up/i }));

    // The shared actionable toast — same title the helper test
    // pins (`provider-not-configured-toast.test.tsx`). If the
    // button accidentally falls through to the generic
    // "Receipt unavailable" branch this assertion fails.
    expect(
      await screen.findByText(/Square isn't connected for this location/i),
    ).toBeInTheDocument();

    const action = await screen.findByRole('button', { name: /open settings/i });
    await user.click(action);

    // Locks the contract: receipt buttons MUST forward locationId
    // so the admin lands on the right location row instead of the
    // bare integrations index.
    expect(navigateMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith('/integrations?location=42');
  });

  // Keep the provider message Square-specific.
  it('keeps Square-specific messaging for every location', async () => {
    mockProviderConfigFetch('square');
    csrfFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: false,
          error: { code: 'PROVIDER_NOT_CONFIGURED', message: 'Square not connected' },
        }),
        { status: 422, headers: { 'content-type': 'application/json' } },
      ),
    );

    const user = userEvent.setup();
    render(
      <>
        <ViewReceiptButton payment={PAYMENT} variant="link" locationId={42} />
        <Toaster />
      </>,
    );

    // Wait for the provider config fetch to settle so the
    // provider configuration is in place by the time we click.
    await screen.findByRole('button', { name: /look up/i });
    await user.click(screen.getByRole('button', { name: /look up/i }));

    expect(
      await screen.findByText(/Square isn't connected for this location/i),
    ).toBeInTheDocument();
  });

  it('falls back to /integrations when no locationId prop is supplied', async () => {
    csrfFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: false,
          error: { code: 'PROVIDER_NOT_CONFIGURED', message: 'Square not connected' },
        }),
        { status: 422, headers: { 'content-type': 'application/json' } },
      ),
    );

    const user = userEvent.setup();
    render(
      <>
        <ViewReceiptButton payment={PAYMENT} variant="link" />
        <Toaster />
      </>,
    );

    await user.click(screen.getByRole('button', { name: /look up/i }));
    await user.click(
      await screen.findByRole('button', { name: /open settings/i }),
    );

    expect(navigateMock).toHaveBeenCalledWith('/integrations');
  });
});
