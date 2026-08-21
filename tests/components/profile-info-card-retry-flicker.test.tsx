/**
 * Component test for ProfileInfoCard's "Retry payment sync" button —
 * locks in the flicker fix from task #438 (this task: #439).
 *
 * The hydration useEffect in ProfileInfoCard mirrors the server-derived
 * `currentUser.paymentSyncStatus` into local state so the retry button
 * shows up on first paint and persists across reloads (#363). After
 * the user clicks "Retry payment sync", the mutation's onSuccess
 * optimistically renders 'synced' AND invalidates /api/user, but the
 * follow-up refetch can race ahead of the bowler row's
 * `payment_sync_pending_at` clear becoming visible to a fresh read —
 * leaving us with a stale 'pending_retry' that, without the latch
 * added in #438, would briefly mirror back into local state and flicker
 * the button into view.
 *
 * Five behaviors are covered here, all easy to silently regress in a
 * future refactor:
 *   1. On mount with `paymentSyncStatus === 'pending_retry'`, the
 *      Retry button is visible.
 *   2. After a successful retry (status !== 'pending_retry'), a
 *      stale `pending_retry` arriving via the next /api/user refetch
 *      within the guard window does NOT re-show the button.
 *   3. A legitimate `null -> pending_retry` transition from the server
 *      (no recent retry click) DOES surface the button.
 *   4. Latch auto-expiry: if the server keeps returning the same
 *      `pending_retry` past `RETRY_FLICKER_GUARD_MS`, the button
 *      eventually reappears — otherwise a real lingering pending
 *      state would be trapped hidden indefinitely (the critical
 *      finding from #438's first code-review pass).
 *   5. A failed retry (mutation resolves with status 'pending_retry')
 *      keeps the Retry button visible — the latch must NOT engage on
 *      this path because the issue isn't actually resolved.
 *
 * `apiRequest` is mocked at the module boundary so the retry POST
 * resolves with whatever shape the test wants. The parent's "refetch"
 * is simulated by `rerender`-ing with a new `currentUser` prop —
 * ProfileInfoCard reads the value from props (the parent owns the
 * /api/user query), so we never need a live QueryClient cache to
 * exercise the hydration path.
 *
 * Fake timers are used throughout so test 4 can deterministically
 * advance past the 30s guard window. We keep them scoped to the
 * primitives the component actually touches (setTimeout/Date) so
 * microtasks remain on real wall clock — necessary for
 * react-query mutations to settle. We also use `fireEvent.click`
 * rather than user-event for the retry click: user-event v14's
 * pointer-event scheduler hangs under fake timers even with the
 * `advanceTimers` option, and a plain click is sufficient for a
 * <Button onClick={...}> with no hover/focus semantics.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/queryClient', async () => {
  // Preserve the real `queryClient` singleton, `getQueryFn`, etc. so
  // the component's `queryClient.invalidateQueries(...)` call inside
  // onSuccess is a no-op against the real cache (nothing in the test
  // reads from it) instead of throwing on a stub. Only `apiRequest`
  // is swapped for a vi.fn we drive from each test.
  const actual = await vi.importActual<typeof import('../../client/src/lib/queryClient')>(
    '../../client/src/lib/queryClient',
  );
  return { ...actual, apiRequest: vi.fn() };
});

import { apiRequest } from '@/lib/queryClient';
import {
  ProfileInfoCard,
  type CurrentUserWithSyncStatus,
} from '@/components/profile-info-card';

const mockedApiRequest = vi.mocked(apiRequest);
const RETRY_BUTTON_TESTID = 'button-retry-payment-sync';
const GUARD_MS = 30_000;

/**
 * Build a CurrentUserWithSyncStatus fixture. The defaults satisfy the
 * Drizzle-inferred User shape (timestamp({ mode: 'string' }) columns
 * are strings, etc.); per-test overrides only need to set the field
 * that matters for the case under test.
 */
function makeUser(
  overrides: Partial<CurrentUserWithSyncStatus> = {},
): CurrentUserWithSyncStatus {
  return {
    id: 1,
    email: 'pending-sync@vitest.local',
    password: 'hashed:irrelevant',
    bowlerId: 99,
    name: 'Pending Sync Tester',
    phone: null,
    avatar: null,
    role: 'user',
    organizationId: 1,
    locationId: null,
    preferredLanguage: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    mustChangePassword: false,
    failedPasswordChangeAttempts: 0,
    passwordChangeLockedUntil: null,
    paymentSyncStatus: null,
    ...overrides,
  };
}

function setup(initial: CurrentUserWithSyncStatus) {
  // A fresh QueryClient per render keeps mutation state from bleeding
  // between tests; retries are off so a rejected mutation surfaces
  // immediately and a resolved one runs onSuccess on the very next
  // microtask.
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const utils = render(
    <QueryClientProvider client={qc}>
      <ProfileInfoCard currentUser={initial} />
    </QueryClientProvider>,
  );
  /** Re-render with a new currentUser — simulates a /api/user refetch. */
  const rerender = (next: CurrentUserWithSyncStatus) =>
    utils.rerender(
      <QueryClientProvider client={qc}>
        <ProfileInfoCard currentUser={next} />
      </QueryClientProvider>,
    );
  return { ...utils, rerender };
}

/**
 * Flush React's pending work and any zero-delay timers so the next
 * assertion sees the post-effect / post-setState DOM.
 *
 * `waitFor` from @testing-library/react is the usual choice, but it
 * polls via setInterval — and we've faked setInterval, so it would
 * spin forever waiting for a tick that never fires. Direct flushing
 * is fine here because:
 *   - Microtasks (Promise resolutions) are NOT faked (see the
 *     `toFake` allowlist in beforeEach), so `await act(async () => {})`
 *     drains react-query's mutation promise chain naturally.
 *   - `vi.advanceTimersByTimeAsync(0)` drives any zero-delay
 *     setTimeouts the latch or React might schedule.
 *
 * A small bounded loop (rather than a fixed N passes) keeps the helper
 * resilient if React Query or React internals add another microtask
 * boundary down the road: we keep flushing as long as the rendered
 * DOM (the proxy for "anything observable changed") is still moving,
 * up to a hard cap so a faulty render loop can't hang the suite.
 */
async function flush(): Promise<void> {
  let lastHtml = document.body.innerHTML;
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const nextHtml = document.body.innerHTML;
    if (nextHtml === lastHtml) return;
    lastHtml = nextHtml;
  }
}

beforeEach(() => {
  mockedApiRequest.mockReset();
  // Fake ONLY the wall-clock primitives the component touches
  // (setTimeout/clearTimeout for the latch's expiry timer, Date for
  // `Date.now()` inside the latch math). Leaving queueMicrotask /
  // Promise / etc. on real wall clock is critical: user-event v14's
  // click scheduler hangs forever when its microtasks are also faked.
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ProfileInfoCard retry button flicker guard (#438 / #439)', () => {
  it('shows the Retry button on mount when paymentSyncStatus is pending_retry', () => {
    setup(makeUser({ paymentSyncStatus: 'pending_retry' }));
    expect(screen.getByTestId(RETRY_BUTTON_TESTID)).toBeInTheDocument();
  });

  it('does NOT re-show the button when a stale /api/user refetch returns pending_retry within the guard window after a successful retry', async () => {
    // Retry endpoint reports the bowler is now in sync. The component
    // optimistically hides the button via setLastSyncStatus('synced').
    mockedApiRequest.mockResolvedValueOnce({
      success: true,
      data: { paymentSyncStatus: 'synced' },
    });

    const { rerender } = setup(makeUser({ paymentSyncStatus: 'pending_retry' }));

    expect(screen.getByTestId(RETRY_BUTTON_TESTID)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId(RETRY_BUTTON_TESTID));
    await flush();
    expect(screen.queryByTestId(RETRY_BUTTON_TESTID)).not.toBeInTheDocument();
    // Causality check: the click really did invoke the retry endpoint
    // exactly once — protects against a future regression where the
    // button hides for an unrelated reason (e.g. the click handler
    // accidentally short-circuits before mutate()).
    expect(mockedApiRequest).toHaveBeenCalledTimes(1);

    // The /api/user refetch races ahead of the bowler row's
    // `payment_sync_pending_at` clear becoming visible to a fresh read,
    // so the prop briefly comes back as 'pending_retry'. The latch
    // must absorb this without flickering the button on.
    rerender(makeUser({ paymentSyncStatus: 'pending_retry' }));
    await flush();
    expect(screen.queryByTestId(RETRY_BUTTON_TESTID)).not.toBeInTheDocument();
  });

  it('does show the button when the server transitions null -> pending_retry from a fresh state (no recent retry click)', async () => {
    const { rerender } = setup(makeUser({ paymentSyncStatus: null }));

    expect(screen.queryByTestId(RETRY_BUTTON_TESTID)).not.toBeInTheDocument();

    // No retry click has latched suppression. A webhook just queued a
    // retry while the tab was open; the hydration effect must mirror
    // the value normally so the user can act on it.
    rerender(makeUser({ paymentSyncStatus: 'pending_retry' }));
    await flush();
    expect(screen.getByTestId(RETRY_BUTTON_TESTID)).toBeInTheDocument();
  });

  it('eventually re-shows the button if the server keeps returning pending_retry past the guard window after a successful retry', async () => {
    mockedApiRequest.mockResolvedValueOnce({
      success: true,
      data: { paymentSyncStatus: 'synced' },
    });

    const { rerender } = setup(makeUser({ paymentSyncStatus: 'pending_retry' }));

    fireEvent.click(screen.getByTestId(RETRY_BUTTON_TESTID));
    await flush();
    expect(screen.queryByTestId(RETRY_BUTTON_TESTID)).not.toBeInTheDocument();
    expect(mockedApiRequest).toHaveBeenCalledTimes(1);

    // Stale refetch — suppressed by the latch (already covered above;
    // re-asserted here so the precondition for the expiry check is
    // explicit).
    rerender(makeUser({ paymentSyncStatus: 'pending_retry' }));
    await flush();
    expect(screen.queryByTestId(RETRY_BUTTON_TESTID)).not.toBeInTheDocument();

    // Critical fix from #438's second review pass: the latch's
    // auto-expiry is deterministic via setTimeout, so advancing past
    // the guard window MUST surface the button — otherwise a real
    // lingering pending state (e.g. the retry didn't actually fix
    // anything server-side) would be trapped hidden indefinitely.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(GUARD_MS + 1);
    });
    expect(screen.getByTestId(RETRY_BUTTON_TESTID)).toBeInTheDocument();
  });

  it('keeps the Retry button visible when a retry click resolves to pending_retry (the retry itself failed)', async () => {
    mockedApiRequest.mockResolvedValueOnce({
      success: true,
      data: { paymentSyncStatus: 'pending_retry' },
    });

    const { rerender } = setup(makeUser({ paymentSyncStatus: 'pending_retry' }));

    fireEvent.click(screen.getByTestId(RETRY_BUTTON_TESTID));
    // Drain the mutation's promise chain. We can't wait on a DOM
    // *change* here (visibility doesn't change — that's the point);
    // the bounded loop in flush() returns early once the DOM stops
    // moving, so this is still tight.
    await flush();
    expect(mockedApiRequest).toHaveBeenCalledTimes(1);

    // Status came back as 'pending_retry' — the retry didn't go
    // through. The latch must NOT engage; the button stays visible so
    // the user can try again.
    expect(screen.getByTestId(RETRY_BUTTON_TESTID)).toBeInTheDocument();

    // And a follow-up /api/user refetch reflecting the same value
    // must still keep it visible (this isn't a flicker scenario at
    // all — the server and client agree).
    rerender(makeUser({ paymentSyncStatus: 'pending_retry' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId(RETRY_BUTTON_TESTID)).toBeInTheDocument();
  });
});
