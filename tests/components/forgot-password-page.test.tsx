/**
 * Component test for the forgot-password page's throttle UX
 * (tasks #411 / #419).
 *
 * Locks in three behaviors that mirror the change-password card:
 *   1. A 429 from POST /api/auth/forgot-password renders the
 *      destructive "too many reset requests" alert.
 *   2. The submit button is disabled while throttled and reads
 *      "Try again in N minute(s)".
 *   3. The alert disappears once the cooldown elapses and the
 *      submit button becomes interactive again.
 *
 * The page uses raw `fetch`, so we mock the global fetch with a
 * route table — /api/org-context returns an empty org so
 * useBusinessContext resolves cleanly, and /api/auth/forgot-password
 * is choreographed per-test.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import ForgotPasswordPage from '@/pages/forgot-password-page';

type FetchHandler = (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>;

const originalFetch = global.fetch;
let forgotHandler: FetchHandler;

function installFetchMock() {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/org-context')) {
      return new Response(JSON.stringify({ success: true, data: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('/api/auth/forgot-password')) {
      return forgotHandler(input, init);
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
      <ForgotPasswordPage />
    </QueryClientProvider>,
  );
}

async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/email address/i), 'user@example.com');
  await user.click(screen.getByTestId('button-forgot-submit'));
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
  forgotHandler = () => new Response('{}', { status: 200 });
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe('ForgotPasswordPage throttle UX', () => {
  it('renders the throttle alert on a 429', async () => {
    forgotHandler = () => rateLimitResponse(120);
    const user = userEvent.setup();
    renderPage();

    await fillAndSubmit(user);

    const alert = await screen.findByTestId('alert-forgot-throttled');
    expect(alert).toBeInTheDocument();
    expect(alert).toHaveTextContent(/too many reset requests/i);
    // 120s rounds up to "2 minutes" via formatCountdown.
    expect(screen.getByTestId('text-forgot-retry-in')).toHaveTextContent(/2 minutes/);
  });

  it('disables the submit button while throttled and shows a countdown label', async () => {
    forgotHandler = () => rateLimitResponse(60);
    const user = userEvent.setup();
    renderPage();

    await fillAndSubmit(user);

    await screen.findByTestId('alert-forgot-throttled');
    const submit = screen.getByTestId('button-forgot-submit');
    expect(submit).toBeDisabled();
    expect(submit).toHaveTextContent(/try again in 1 minute/i);
  });

  it('clears the throttle alert once the cooldown elapses', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      forgotHandler = () => rateLimitResponse(1);
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderPage();

      await fillAndSubmit(user);

      await waitFor(() =>
        expect(screen.getByTestId('alert-forgot-throttled')).toBeInTheDocument(),
      );
      expect(screen.getByTestId('button-forgot-submit')).toBeDisabled();

      await vi.advanceTimersByTimeAsync(1500);

      await waitFor(() =>
        expect(screen.queryByTestId('alert-forgot-throttled')).not.toBeInTheDocument(),
      );
      expect(screen.getByTestId('button-forgot-submit')).not.toBeDisabled();
    } finally {
      vi.useRealTimers();
    }
  });
});
