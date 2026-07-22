/**
 * Component test for the PROVIDER_NOT_CONFIGURED branch in
 * <SavedPaymentMethodsCard /> (task #595).
 *
 * Background: when a bowler removes a saved card and the owning
 * location no longer has provider credentials,
 * `DELETE /api/payments-provider/cards/:bowlerId/:cardId` returns
 * 422 PROVIDER_NOT_CONFIGURED. Removal used to surface that as a
 * generic "Error: Failed to remove card" toast — confusing for an
 * action the bowler thought was account-local. It now fires the
 * shared actionable toast and forwards the parent's `locationId`
 * so the deep-link lands on the right location row in the
 * integrations page.
 *
 * `tests/components/provider-not-configured-toast.test.tsx`
 * already covers the helper itself; this file pins the
 * `saved-payment-methods-card.tsx` -> helper wiring so a future
 * refactor can't silently drop the location id.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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

import type { SavedCard } from '@shared/schema';

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

import { SavedPaymentMethodsCard } from '@/components/saved-payment-methods-card';
import { Toaster } from '@/components/ui/toaster';

const BOWLER_ID = 11;

const SAVED_CARD: SavedCard = {
  id: 'card_abc',
  last4: '4242',
  brand: 'Visa',
  expMonth: 12,
  expYear: 2030,
};

function renderCard(opts: { locationId?: number | null } = {}) {
  const qc = new QueryClient({
    defaultOptions: {
      // staleTime: Infinity keeps the seeded data fresh so React
      // Query never fires the component's queryFn on mount —
      // otherwise the saved-cards csrfFetch call would consume
      // the `mockResolvedValueOnce` we set up for the DELETE.
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  // Seed the saved-cards query so the card row renders without
  // needing to mock a successful list fetch first.
  qc.setQueryData([`/api/payments-provider/cards/${BOWLER_ID}`], {
    success: true,
    data: [SAVED_CARD],
  });

  return render(
    <QueryClientProvider client={qc}>
      <SavedPaymentMethodsCard
        bowlerId={BOWLER_ID}
        locationId={opts.locationId ?? null}
      />
      <Toaster />
    </QueryClientProvider>,
  );
}

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

describe('<SavedPaymentMethodsCard /> — PROVIDER_NOT_CONFIGURED branch (#595)', () => {
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
    renderCard({ locationId: 42 });

    // Click the row's Remove button -> opens the AlertDialog.
    await user.click(screen.getByRole('button', { name: /remove/i }));

    // Confirm in the AlertDialog -> fires the DELETE that returns
    // PROVIDER_NOT_CONFIGURED.
    await user.click(
      await screen.findByRole('button', { name: /remove card/i }),
    );

    expect(
      await screen.findByText(/Square isn't connected for this location/i),
    ).toBeInTheDocument();

    // findByText (not findByRole) — Radix AlertDialog can flip
    // the toast viewport's a11y tree to hidden while a confirm
    // dialog is mid-tear-down, so walk the raw DOM instead.
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
    renderCard({ locationId: 42 });

    // Wait for the card row + provider config to settle so the
    // provider configuration is in place by the time we click.
    await screen.findByRole('button', { name: /remove/i });
    await user.click(screen.getByRole('button', { name: /remove/i }));
    await user.click(
      await screen.findByRole('button', { name: /remove card/i }),
    );

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
    renderCard();

    await user.click(screen.getByRole('button', { name: /remove/i }));
    await user.click(
      await screen.findByRole('button', { name: /remove card/i }),
    );
    // findByText — see comment in the locationId-set test above.
    await user.click(await screen.findByText(/open settings/i));

    expect(navigateMock).toHaveBeenCalledWith('/integrations');
  });
});
