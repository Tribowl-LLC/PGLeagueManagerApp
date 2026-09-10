/**
 * Component test for the login page's throttle UX (tasks #411 / #419).
 *
 * Locks in three behaviors that mirror the change-password card:
 *   1. A 429 from POST /api/auth/login renders the destructive
 *      "too many sign-in attempts" alert with a working
 *      "Reset it instead" link to /forgot-password.
 *   2. The submit button is disabled while throttled and reads
 *      "Try again in N minute(s)".
 *   3. The alert disappears once the cooldown elapses and the
 *      submit button becomes interactive again.
 *
 * The page uses raw `fetch` (not apiRequest), so we mock the global
 * fetch with a tiny route table — /api/org-context returns an empty
 * org so useSubdomainOrg resolves cleanly, and /api/auth/login can
 * be choreographed per-test.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import LoginPage from '@/pages/login-page';

type FetchHandler = (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>;

const originalFetch = global.fetch;
let loginHandler: FetchHandler;

function installFetchMock() {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/org-context')) {
      // useSubdomainOrg's query — return an empty org so the page
      // renders without a logo or org-name copy and doesn't retry.
      return new Response(JSON.stringify({ success: true, data: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('/api/auth/login')) {
      return loginHandler(input, init);
    }
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
}

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <LoginPage />
    </QueryClientProvider>,
  );
}

async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/email address/i), 'user@example.com');
  await user.type(screen.getByLabelText(/^password$/i), 'hunter2!!');
  await user.click(screen.getByTestId('button-login-submit'));
}

function rateLimitResponse(retryAfterSeconds: number): Response {
  return new Response(JSON.stringify({ error: { message: 'Too many requests' } }), {
    status: 429,
    headers: {
      'content-type': 'application/json',
      'retry-after': String(retryAfterSeconds),
    },
  });
}

beforeEach(() => {
  installFetchMock();
  // Default handler — individual tests overwrite this.
  loginHandler = () => new Response('{}', { status: 200 });
});

afterEach(() => {
  global.fetch = originalFetch;
  window.history.replaceState(null, '', '/');
});

describe('LoginPage throttle UX', () => {
  it('shows the explicit expired-session banner only for the session-expired reason', async () => {
    window.history.pushState(null, '', '/login?reason=session-expired');
    renderPage();

    expect(await screen.findByTestId('alert-session-expired')).toHaveTextContent(
      'Your session expired. Please sign in again.',
    );

    window.history.replaceState(null, '', '/');
  });

  it('renders the throttle alert and Reset-it-instead link on a 429', async () => {
    loginHandler = () => rateLimitResponse(120);
    const user = userEvent.setup();
    renderPage();

    await fillAndSubmit(user);

    const alert = await screen.findByTestId('alert-login-throttled');
    expect(alert).toBeInTheDocument();
    expect(alert).toHaveTextContent(/too many sign-in attempts/i);
    // 120s rounds up to "2 minutes" via formatCountdown.
    expect(screen.getByTestId('text-login-retry-in')).toHaveTextContent(/2 minutes/);
    const forgotLink = screen.getByTestId('link-login-throttled-forgot');
    expect(forgotLink).toBeInTheDocument();
    expect(forgotLink).toHaveAttribute('href', '/forgot-password');
  });

  it('disables the submit button while throttled and shows a countdown label', async () => {
    loginHandler = () => rateLimitResponse(60);
    const user = userEvent.setup();
    renderPage();

    await fillAndSubmit(user);

    await screen.findByTestId('alert-login-throttled');
    const submit = screen.getByTestId('button-login-submit');
    expect(submit).toBeDisabled();
    // 60s → "1 minute" exactly.
    expect(submit).toHaveTextContent(/try again in 1 minute/i);
  });

  it('clears the throttle alert once the cooldown elapses', async () => {
    // 1-second cooldown with real timers — fake timers tangle with
    // user-event's typing scheduler. The hook's tick interval runs
    // on real time, so a generous waitFor window is enough.
    loginHandler = () => rateLimitResponse(1);
    const user = userEvent.setup();
    renderPage();

    await fillAndSubmit(user);

    await waitFor(() =>
      expect(screen.getByTestId('alert-login-throttled')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('button-login-submit')).toBeDisabled();

    await waitFor(
      () =>
        expect(screen.queryByTestId('alert-login-throttled')).not.toBeInTheDocument(),
      { timeout: 5000 },
    );
    expect(screen.getByTestId('button-login-submit')).not.toBeDisabled();
  });
});
