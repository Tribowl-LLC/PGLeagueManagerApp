/**
 * Component test for PaymentSyncRetryStatus's response parsing
 * (task #489).
 *
 * Background: before #489 this component compared
 * `resp.data.paymentSyncStatus` against the literal string `"synced"`
 * with a `?? "synced"` fallback. That meant:
 *   - a missing field defaulted to "synced" and fired the green
 *     "Payment sync succeeded" toast even though the server never
 *     said anything,
 *   - any unknown future status (older client + newer server adding
 *     a fifth state) silently failed the equality check and at least
 *     didn't fire success — but a typo'd status like "syncedd" or a
 *     casing change like "Synced" would have made the silent-success
 *     case worse, not better.
 *
 * After #489: the response is routed through the shared
 * `parsePaymentSyncStatus` helper from `shared/schema/bowlers.ts`.
 * Anything outside the known union collapses to `"not_applicable"`,
 * which means the success toast can ONLY fire when the server
 * explicitly returned `"synced"`. This test pins that contract.
 *
 * Mocking strategy mirrors the sibling profile-info-card retry tests:
 * `apiRequest` is mocked at the module boundary so the POST resolves
 * with whatever shape we want, and `useToast` is mocked so we can
 * assert exactly which toast variant fired.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/queryClient', async () => {
  const actual = await vi.importActual<typeof import('../../client/src/lib/queryClient')>(
    '../../client/src/lib/queryClient',
  );
  return {
    ...actual,
    apiRequest: vi.fn(),
    queryClient: {
      invalidateQueries: vi.fn(),
    },
  };
});

const toastFn = vi.fn();
vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: toastFn }),
}));

import { apiRequest } from '@/lib/queryClient';
import { PaymentSyncRetryStatus } from '@/components/payment-sync-retry-status';

const mockedApiRequest = vi.mocked(apiRequest);

const PENDING_BOWLER = {
  id: 77,
  paymentSyncPendingAt: '2026-04-26T12:00:00.000Z',
  paymentSyncAttempts: 1,
  paymentSyncLastAttemptAt: '2026-04-26T12:05:00.000Z',
  paymentSyncNextRetryAt: '2026-04-26T12:07:00.000Z',
};

function renderRetry() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <PaymentSyncRetryStatus bowler={PENDING_BOWLER} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  toastFn.mockReset();
  mockedApiRequest.mockReset();
});

describe('PaymentSyncRetryStatus — shared status parser (#489)', () => {
  it('does NOT fire the success toast when the server returns an unknown paymentSyncStatus', async () => {
    // Simulate an older client + newer server: a status the client
    // doesn't know about yet. Pre-#489 the equality check `=== "synced"`
    // still failed, but the safety relied on that single literal not
    // drifting; e.g. a future "syncing" / casing change would have to
    // be re-audited every time. The shared parser collapses anything
    // unknown to `not_applicable` so the success path is structurally
    // unreachable for non-`'synced'` values.
    mockedApiRequest.mockResolvedValueOnce({
      success: true,
      data: { paymentSyncStatus: 'totally-bogus-future-state' },
    });

    renderRetry();

    fireEvent.click(screen.getByTestId(`button-retry-payment-sync-${PENDING_BOWLER.id}`));

    // Wait for the mutation to settle — a toast must fire either way
    // (the component always toasts on success), so we can use that as
    // our settle signal without racing.
    await waitFor(() => {
      expect(toastFn).toHaveBeenCalledTimes(1);
    });

    // The single toast must be the destructive "still pending" one,
    // never the green "succeeded" one.
    expect(toastFn).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Payment sync still pending',
        variant: 'destructive',
      }),
    );
    expect(toastFn).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Payment sync succeeded' }),
    );
  });

  it('does NOT fire the success toast when paymentSyncStatus is missing entirely (no more "?? synced" default)', async () => {
    // The pre-#489 code did `status = resp?.data?.paymentSyncStatus ?? "synced"`,
    // so a response with no status field was treated as success and the
    // user got a misleading green toast. Pin the new behavior: missing
    // → parser returns `not_applicable` → "still pending" toast.
    mockedApiRequest.mockResolvedValueOnce({
      success: true,
      data: {},
    });

    renderRetry();

    fireEvent.click(screen.getByTestId(`button-retry-payment-sync-${PENDING_BOWLER.id}`));

    await waitFor(() => {
      expect(toastFn).toHaveBeenCalledTimes(1);
    });

    expect(toastFn).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Payment sync still pending',
        variant: 'destructive',
      }),
    );
    expect(toastFn).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Payment sync succeeded' }),
    );
  });

  it('still fires the success toast on a real "synced" response (regression baseline)', async () => {
    // Without this, the "unknown → no success" assertion above could
    // silently degrade into "no input ever fires success" (e.g. if a
    // refactor accidentally hard-codes `ok = false`). This baseline
    // proves the success path is still reachable.
    mockedApiRequest.mockResolvedValueOnce({
      success: true,
      data: { paymentSyncStatus: 'synced' },
    });

    renderRetry();

    fireEvent.click(screen.getByTestId(`button-retry-payment-sync-${PENDING_BOWLER.id}`));

    await waitFor(() => {
      expect(toastFn).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Payment sync succeeded',
          variant: 'default',
        }),
      );
    });
  });
});
