/**
 * Component test for the change-password card's throttle UX
 * (tasks #355 / #411 / #412).
 *
 * Locks in three behaviors the manual smoke test can't catch in CI:
 *   1. A 429 / RATE_LIMITED error from `apiRequest` renders the
 *      destructive "too many attempts" alert with a working
 *      "Reset it instead" link to /forgot-password.
 *   2. The submit button is disabled while throttled and reads
 *      "Try again in N minute(s)".
 *   3. The alert disappears once the cooldown elapses and the
 *      submit button becomes interactive again.
 *
 * `apiRequest` is mocked at the module boundary so we don't need a
 * real fetch / network and so we can choreograph success and 429
 * outcomes deterministically.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/queryClient', async () => {
  // Preserve the real exports (queryClient, parseRetryAfterSeconds,
  // etc.) so consumers other than `apiRequest` keep working — only
  // `apiRequest` is swapped for a vi.fn we drive from the tests.
  const actual = await vi.importActual<typeof import('../../client/src/lib/queryClient')>(
    '../../client/src/lib/queryClient',
  );
  return {
    ...actual,
    apiRequest: vi.fn(),
    redirectToLoginForExpiredSession: vi.fn(),
  };
});

import { apiRequest, redirectToLoginForExpiredSession } from '@/lib/queryClient';
import { ChangePasswordCard } from '@/components/change-password-card';

const mockedApiRequest = vi.mocked(apiRequest);
const mockedRedirectToLogin = vi.mocked(redirectToLoginForExpiredSession);

/**
 * Build the same shape of error `apiRequest` throws on a 429 — see
 * `throwIfResNotOk` in client/src/lib/queryClient.ts.
 */
function makeRateLimitError(retryAfterSeconds: number | null): Error {
  const err = new Error(`429: Too many requests`) as Error & {
    status: number;
    code: string;
    retryAfterSeconds: number | null;
  };
  err.status = 429;
  err.code = 'RATE_LIMITED';
  err.retryAfterSeconds = retryAfterSeconds;
  return err;
}

function renderCard() {
  // Each test gets its own QueryClient so mutation state doesn't
  // bleed across tests, with retry off so a rejected mutation
  // surfaces immediately.
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <ChangePasswordCard />
    </QueryClientProvider>,
  );
}

/** Reveal the form, fill it with valid values, and submit. */
async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /change password/i }));
  await user.type(screen.getByLabelText(/^current password$/i), 'currentpw');
  await user.type(screen.getByLabelText(/^new password$/i), 'newpassword');
  await user.type(screen.getByLabelText(/^confirm new password$/i), 'newpassword');
  await user.click(screen.getByTestId('button-change-password-submit'));
}

beforeEach(() => {
  mockedApiRequest.mockReset();
  mockedRedirectToLogin.mockReset();
});

describe('ChangePasswordCard throttle UX', () => {
  it('renders the throttle alert and Forgot Password link on a 429', async () => {
    mockedApiRequest.mockRejectedValueOnce(makeRateLimitError(120));
    const user = userEvent.setup();
    renderCard();

    await fillAndSubmit(user);

    const alert = await screen.findByTestId('alert-change-password-throttled');
    expect(alert).toBeInTheDocument();
    expect(alert).toHaveTextContent(/too many attempts/i);
    // 120s rounds up to "2 minutes" via formatCountdown.
    expect(screen.getByTestId('text-change-password-retry-in')).toHaveTextContent(
      /2 minutes/,
    );
    const forgotLink = screen.getByTestId('link-change-password-forgot');
    expect(forgotLink).toBeInTheDocument();
    expect(forgotLink).toHaveAttribute('href', '/forgot-password');
  });

  it('disables the submit button while throttled and shows a countdown label', async () => {
    mockedApiRequest.mockRejectedValueOnce(makeRateLimitError(60));
    const user = userEvent.setup();
    renderCard();

    await fillAndSubmit(user);

    await screen.findByTestId('alert-change-password-throttled');
    const submit = screen.getByTestId('button-change-password-submit');
    expect(submit).toBeDisabled();
    // 60s → "1 minute" exactly.
    expect(submit).toHaveTextContent(/try again in 1 minute/i);
  });

  it('clears the throttle alert once the cooldown elapses', async () => {
    // Use a 1-second window with real timers — fake timers tangle with
    // user-event's typing scheduler and Radix's portal mounts. The
    // hook's tick interval runs on real time, so a ~1.5s wait is
    // enough to observe the alert tear down.
    mockedApiRequest.mockRejectedValueOnce(makeRateLimitError(1));
    const user = userEvent.setup();
    renderCard();

    await fillAndSubmit(user);

    await waitFor(() =>
      expect(screen.getByTestId('alert-change-password-throttled')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('button-change-password-submit')).toBeDisabled();

    await waitFor(
      () =>
        expect(
          screen.queryByTestId('alert-change-password-throttled'),
        ).not.toBeInTheDocument(),
      // Generous timeout because the hook's tick interval and React's
      // commit phase both run on real time here; a tight bound gets
      // flaky on contended CI runners.
      { timeout: 5000 },
    );
    expect(screen.getByTestId('button-change-password-submit')).not.toBeDisabled();
  });

  it('routes to a fresh login after a committed change whose session refresh failed', async () => {
    mockedApiRequest.mockResolvedValueOnce({
      success: true,
      data: {
        message: 'Password updated successfully',
        requiresLogin: true,
      },
    });
    const user = userEvent.setup();
    renderCard();

    await fillAndSubmit(user);

    await waitFor(() => expect(mockedRedirectToLogin).toHaveBeenCalledTimes(1));
    expect(mockedRedirectToLogin).toHaveBeenCalledWith({
      cachedAuthenticated: true,
      force: true,
      reason: 'credential-changed',
    });
    // The response is handled as completion, so the mutation must not enter
    // the destructive error path or ask the user to retry the already-committed
    // password change.
    expect(screen.queryByText(/password change failed/i)).not.toBeInTheDocument();
  });
});
