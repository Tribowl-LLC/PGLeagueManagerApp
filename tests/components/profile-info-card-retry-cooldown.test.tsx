/**
 * Component test for ProfileInfoCard's "Retry payment sync" cooldown
 * UX (task #441).
 *
 * Background: the self-serve retry endpoint is throttled at 5/min per
 * user (task #365). Before #441 the only feedback on a 429 was a
 * toast — the button stayed clickable and the underlying status
 * didn't change, so a confused user would just keep mashing it.
 *
 * Now: when the retry mutation gets a 429, ProfileInfoCard reads the
 * `Retry-After` header (already parsed into `err.retryAfterSeconds`
 * by `apiRequest`), disables the button until the deadline, and
 * renders an inline "Try again in Ns" countdown that ticks once a
 * second and disappears on its own when the cooldown elapses.
 *
 * Three behaviors are pinned here, all easy to silently regress:
 *   1. After a 429 with Retry-After=42, the button is disabled and
 *      the inline countdown reads "Try again in 42s".
 *   2. The countdown ticks down — at +41s the label reads
 *      "Try again in 1s" and the button is still disabled.
 *   3. At +42s the cooldown clears on its own: the inline message
 *      disappears and the button is re-enabled, with no rerender or
 *      manual refresh needed.
 *
 * Mocking strategy mirrors the sibling flicker test
 * (profile-info-card-retry-flicker.test.tsx): `apiRequest` is mocked
 * at the module boundary so the retry POST rejects with the exact
 * shape `apiRequest` synthesizes for a real 429
 * (Error & { status: 429, retryAfterSeconds: 42 }). Fake timers are
 * scoped to the wall-clock primitives the component touches
 * (setTimeout/setInterval/Date) so microtasks remain on real wall
 * clock and react-query's mutation promise chain settles naturally.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/queryClient', async () => {
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
const COOLDOWN_TEXT_TESTID = 'text-retry-cooldown';

function makeUser(
  overrides: Partial<CurrentUserWithSyncStatus> = {},
): CurrentUserWithSyncStatus {
  return {
    id: 1,
    email: 'cooldown@vitest.local',
    password: 'hashed:irrelevant',
    bowlerId: 99,
    name: 'Cooldown Tester',
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
    paymentSyncStatus: 'pending_retry',
    ...overrides,
  };
}

function setup() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <ProfileInfoCard currentUser={makeUser()} />
    </QueryClientProvider>,
  );
}

/**
 * Build a 429 error with the exact shape `apiRequest` synthesizes for
 * a real rate-limited response — Error subclass with `.status = 429`
 * and `.retryAfterSeconds` already parsed from the response headers.
 * The component must read `retryAfterSeconds`, not re-parse anything.
 */
function rateLimitedError(retryAfterSeconds: number): Error {
  const err = new Error(
    `429: Too many retry attempts. Please wait a minute and try again.`,
  ) as Error & { status?: number; retryAfterSeconds?: number | null };
  err.status = 429;
  err.retryAfterSeconds = retryAfterSeconds;
  return err;
}

/**
 * Drain microtasks + zero-delay timers so the next assertion observes
 * the post-mutation, post-effect DOM. Identical pattern to the sibling
 * flicker test — see its docstring for why we can't use `waitFor`
 * under fake timers.
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
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ProfileInfoCard retry button cooldown (#441)', () => {
  it('disables the button and shows "Try again in 42s" after a 429 with Retry-After=42', async () => {
    mockedApiRequest.mockRejectedValueOnce(rateLimitedError(42));

    setup();

    const button = screen.getByTestId(RETRY_BUTTON_TESTID);
    expect(button).not.toBeDisabled();
    expect(screen.queryByTestId(COOLDOWN_TEXT_TESTID)).not.toBeInTheDocument();

    fireEvent.click(button);
    await flush();

    // Causality check: the click really did invoke the retry endpoint
    // exactly once (and got the mocked 429 we set up).
    expect(mockedApiRequest).toHaveBeenCalledTimes(1);

    expect(screen.getByTestId(RETRY_BUTTON_TESTID)).toBeDisabled();
    expect(screen.getByTestId(COOLDOWN_TEXT_TESTID)).toHaveTextContent(
      'Try again in 42s',
    );
  });

  it('ticks the countdown down each second and keeps the button disabled until the deadline', async () => {
    mockedApiRequest.mockRejectedValueOnce(rateLimitedError(42));

    setup();

    fireEvent.click(screen.getByTestId(RETRY_BUTTON_TESTID));
    await flush();

    // After 41s the label should read "Try again in 1s" (one second
    // of cooldown left). Button remains disabled — ANY undisable in
    // this window means a confused user could click straight into
    // another 429, the very thing #441 prevents.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(41_000);
    });
    expect(screen.getByTestId(COOLDOWN_TEXT_TESTID)).toHaveTextContent(
      'Try again in 1s',
    );
    expect(screen.getByTestId(RETRY_BUTTON_TESTID)).toBeDisabled();
  });

  it('clears the cooldown on its own when the deadline passes — button re-enables, message disappears, no manual refresh', async () => {
    mockedApiRequest.mockRejectedValueOnce(rateLimitedError(42));

    setup();

    fireEvent.click(screen.getByTestId(RETRY_BUTTON_TESTID));
    await flush();
    expect(screen.getByTestId(RETRY_BUTTON_TESTID)).toBeDisabled();

    // Advance just past the 42s deadline. The next setInterval tick
    // should observe `Date.now() >= cooldownUntilMs` and clear the
    // cooldown, which re-enables the button and unmounts the inline
    // message — the spec's "no manual refresh needed" requirement.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(43_000);
    });

    expect(screen.queryByTestId(COOLDOWN_TEXT_TESTID)).not.toBeInTheDocument();
    expect(screen.getByTestId(RETRY_BUTTON_TESTID)).not.toBeDisabled();
  });

  it('falls back to a 60s cooldown when a 429 lacks both Retry-After and RateLimit-Reset (defensive — matches limiter window)', async () => {
    // Simulates a 429 where a misconfigured proxy stripped both
    // standard headers (or some future limiter swap forgets to set
    // them). `apiRequest` would surface that as `retryAfterSeconds:
    // null`. Without the fallback the button would stay enabled and
    // the user would mash straight into another 429 — the exact
    // scenario #441 was filed to prevent. Lock the 60s fallback in.
    const err = new Error(
      `429: Too many retry attempts. Please wait a minute and try again.`,
    ) as Error & { status?: number; retryAfterSeconds?: number | null };
    err.status = 429;
    err.retryAfterSeconds = null;
    mockedApiRequest.mockRejectedValueOnce(err);

    setup();

    fireEvent.click(screen.getByTestId(RETRY_BUTTON_TESTID));
    await flush();

    expect(screen.getByTestId(RETRY_BUTTON_TESTID)).toBeDisabled();
    expect(screen.getByTestId(COOLDOWN_TEXT_TESTID)).toHaveTextContent(
      'Try again in 60s',
    );
  });

  it('after the cooldown ends the user can click retry again and the mutation actually fires', async () => {
    // Round-trip: 429 → wait out the cooldown → second click must
    // reach the endpoint. Guards against a regression where the
    // cooldown clear forgets to clear `retryMutation.isPending` or
    // some other intermediate state, leaving the button visually
    // enabled but functionally inert (worse than the original bug).
    mockedApiRequest.mockRejectedValueOnce(rateLimitedError(42));
    mockedApiRequest.mockResolvedValueOnce({
      success: true,
      data: { paymentSyncStatus: 'synced' },
    });

    setup();

    fireEvent.click(screen.getByTestId(RETRY_BUTTON_TESTID));
    await flush();
    expect(mockedApiRequest).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId(RETRY_BUTTON_TESTID)).toBeDisabled();

    // Wait the cooldown out.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(43_000);
    });
    expect(screen.getByTestId(RETRY_BUTTON_TESTID)).not.toBeDisabled();

    // Second click must actually invoke the endpoint AND, on the
    // resolved 'synced' response, hide the retry button entirely
    // (lastSyncStatus mirrors out of 'pending_retry').
    fireEvent.click(screen.getByTestId(RETRY_BUTTON_TESTID));
    await flush();
    expect(mockedApiRequest).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId(RETRY_BUTTON_TESTID)).not.toBeInTheDocument();
  });
});
