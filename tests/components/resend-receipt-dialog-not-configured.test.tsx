/**
 * Component test for the PROVIDER_NOT_CONFIGURED branch in
 * <ResendReceiptDialog /> (task #595).
 *
 * Background: when an admin tries to resend a Square receipt for a
 * card row whose owning location no longer has provider credentials,
 * `POST /api/payments-provider/payments/:id/resend-receipt` returns
 * 422 PROVIDER_NOT_CONFIGURED. The dialog used to surface that as a
 * generic "Error: ..." toast. It now fires the shared actionable
 * toast and forwards the row's `locationId` so "Open Settings"
 * deep-links to `/integrations?location=<id>` instead of dumping the
 * admin on the bare integrations index.
 *
 * `tests/components/provider-not-configured-toast.test.tsx`
 * already covers the helper itself; this file pins the
 * `resend-receipt-dialog.tsx` -> helper wiring so a future refactor
 * can't silently drop the location id.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { clearProviderConfigCache } from '@/hooks/use-payment-provider';

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

import { ResendReceiptDialog } from '@/components/resend-receipt-dialog';
import { Toaster } from '@/components/ui/toaster';

const PAYMENT: Payment = {
  id: 202,
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
  providerPaymentId: 'sq_pay_xyz',
  idempotencyKey: null,
  squareRefundId: null,
  refundReason: null,
  refundedAt: null,
  disputeId: null,
  disputedAt: null,
  receiptUrl: 'https://squareup.com/receipt/old',
  receiptNumber: 'R-001',
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
  // Module-level cache in `usePaymentProvider` would otherwise let
  // one test's config response leak into another assertion.
  clearProviderConfigCache();
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe('<ResendReceiptDialog /> — PROVIDER_NOT_CONFIGURED branch (#595)', () => {
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
        <ResendReceiptDialog
          payment={PAYMENT}
          defaultEmail="bowler@example.com"
          onClose={() => {}}
          locationId={42}
        />
        <Toaster />
      </>,
    );

    // The "Send Receipt" button triggers the POST that returns
    // PROVIDER_NOT_CONFIGURED — leave the prefilled email alone so
    // the client-side validation can't short-circuit the request.
    await user.click(screen.getByRole('button', { name: /send receipt/i }));

    expect(
      await screen.findByText(/Square isn't connected for this location/i),
    ).toBeInTheDocument();

    // Note: the dialog stays open after the toast fires (the
    // helper only renders the toast, it doesn't close the
    // dialog), and Radix Dialog flips its body siblings —
    // including the toast viewport — to aria-hidden while it's
    // mounted. `findByText` walks the raw DOM, sidestepping the
    // a11y tree, so we still assert against the visible action
    // button by text.
    const action = await screen.findByText(/open settings/i);
    await user.click(action);

    expect(navigateMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith('/integrations?location=42');
  });

  // Pin the Square-specific provider message.
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
        <ResendReceiptDialog
          payment={PAYMENT}
          defaultEmail="bowler@example.com"
          onClose={() => {}}
          locationId={42}
        />
        <Toaster />
      </>,
    );

    // Wait for the dialog (and the provider config fetch) to settle.
    await screen.findByRole('button', { name: /send receipt/i });
    await user.click(screen.getByRole('button', { name: /send receipt/i }));

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
        <ResendReceiptDialog
          payment={PAYMENT}
          defaultEmail="bowler@example.com"
          onClose={() => {}}
        />
        <Toaster />
      </>,
    );

    await user.click(screen.getByRole('button', { name: /send receipt/i }));
    // findByText (not findByRole) — the open dialog hides its
    // sibling toast viewport from the a11y tree; see the comment
    // in the locationId-set test above.
    await user.click(await screen.findByText(/open settings/i));

    expect(navigateMock).toHaveBeenCalledWith('/integrations');
  });
});
