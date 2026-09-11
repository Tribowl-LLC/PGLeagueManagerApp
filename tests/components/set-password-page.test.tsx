/**
 * Component test for the set-password / accept-invite page's
 * throttle UX (task #418).
 *
 * Locks in three behaviors that mirror the forgot-password and
 * change-password throttle banners:
 *   1. A 429 from POST /api/auth/set-password renders the
 *      destructive "too many attempts" alert, with the right
 *      countdown text driven by the Retry-After header.
 *   2. The submit button is disabled while throttled and reads
 *      "Try again in N minute(s)".
 *   3. The alert disappears once the cooldown elapses and the
 *      submit button becomes interactive again.
 *
 * The page uses raw `fetch`, so we mock the global fetch with a
 * route table — /api/auth/validate-invite resolves the invitation
 * synchronously so the form mounts, and /api/auth/set-password is
 * choreographed per-test.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';

import SetPasswordPage from '@/pages/set-password-page';

type FetchHandler = (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>;

const originalFetch = global.fetch;
const originalLocationHref = window.location.href;
let setPasswordHandler: FetchHandler;
let validateHandler: FetchHandler;

function installFetchMock() {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/auth/validate-invite')) {
      return validateHandler(input, init);
    }
    if (url.includes('/api/auth/set-password')) {
      return setPasswordHandler(input, init);
    }
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
}

// The page reads `?token=...` from the URL. Use wouter's memory
// router with a hook factory that always reports a search string
// containing a fake token, so the page's effect can extract it.
const testMemoryLocation = memoryLocation({ path: '/set-password', record: true });
const { hook: memoryHook } = testMemoryLocation;
let testSearch = 'token=valid-test-token';
function useTestSearch(): string {
  return testSearch;
}

function pageElement(qc: QueryClient) {
  return (
    <QueryClientProvider client={qc}>
      <Router hook={memoryHook} searchHook={useTestSearch}>
        <SetPasswordPage />
      </Router>
    </QueryClientProvider>
  );
}

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const result = render(pageElement(qc));
  return {
    ...result,
    rerenderPage: () => result.rerender(pageElement(qc)),
  };
}

const STRONG_PASSWORD = 'StrongPw1!2026';

async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>) {
  // Wait for the post-validate render — the form only mounts after
  // /api/auth/validate-invite resolves.
  const pwInput = await screen.findByLabelText(/^Password$/i);
  const confirmInput = await screen.findByLabelText(/confirm password/i);
  await user.type(pwInput, STRONG_PASSWORD);
  await user.type(confirmInput, STRONG_PASSWORD);
  await user.click(screen.getByTestId('button-set-password-submit'));
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
  testSearch = 'token=valid-test-token';
  testMemoryLocation.reset?.();
  installFetchMock();
  validateHandler = () =>
    new Response(
      JSON.stringify({
        success: true,
        data: { email: 'p***@example.com' },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  setPasswordHandler = () =>
    new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  // Stub navigation: the success path does
  // `window.location.href = '/'` which jsdom can't actually follow.
  // Re-defining the property keeps assignment a no-op so the test
  // doesn't unload the document mid-assertion.
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { href: originalLocationHref },
  });
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe('SetPasswordPage throttle UX (task #418)', () => {
  it('renders the throttle alert on a 429 with the right countdown text', async () => {
    setPasswordHandler = () => rateLimitResponse(120);
    const user = userEvent.setup();
    renderPage();

    await fillAndSubmit(user);

    const alert = await screen.findByTestId('alert-set-password-throttled');
    expect(alert).toBeInTheDocument();
    expect(alert).toHaveTextContent(/too many attempts/i);
    // The banner must reassure the user that the link itself is
    // still valid — without this, recipients hit 429 then go ask
    // for a brand-new email, invalidating their existing token.
    expect(alert).toHaveTextContent(/may still be valid/i);
    // 120s rounds up to "2 minutes" via formatCountdown.
    expect(screen.getByTestId('text-set-password-retry-in')).toHaveTextContent(/2 minutes/);
  });

  it('disables the submit button while throttled and shows a countdown label', async () => {
    setPasswordHandler = () => rateLimitResponse(60);
    const user = userEvent.setup();
    renderPage();

    await fillAndSubmit(user);

    await screen.findByTestId('alert-set-password-throttled');
    const submit = screen.getByTestId('button-set-password-submit');
    expect(submit).toBeDisabled();
    expect(submit).toHaveTextContent(/try again in 1 minute/i);
  });

  it('clears the throttle alert once the cooldown elapses', async () => {
    setPasswordHandler = () => rateLimitResponse(1);
    const user = userEvent.setup();
    renderPage();

    await fillAndSubmit(user);

    await waitFor(() =>
      expect(screen.getByTestId('alert-set-password-throttled')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('button-set-password-submit')).toBeDisabled();

    await waitFor(
      () =>
        expect(screen.queryByTestId('alert-set-password-throttled')).not.toBeInTheDocument(),
      { timeout: 5000 },
    );
    expect(screen.getByTestId('button-set-password-submit')).not.toBeDisabled();
  });

  it('does NOT show the throttle alert on a normal success response', async () => {
    // Regression guard: the success path falls through to `await
    // response.json()` — make sure that path doesn't accidentally
    // also fire `throttle()`. Without this, a future refactor that
    // moved the 429 check below the json parse could silently
    // throttle every successful submit.
    const user = userEvent.setup();
    renderPage();

    await fillAndSubmit(user);

    // Give the success handler a tick to settle.
    await waitFor(() =>
      expect(screen.queryByTestId('alert-set-password-throttled')).not.toBeInTheDocument(),
    );
  });

  it('handles a 429 with no JSON body without crashing (the 429 branch must run BEFORE response.json())', async () => {
    // Regression guard. Some upstream proxies return a 429 with an
    // empty body or a `text/plain` body. If the route handler
    // awaited `response.json()` before checking the status, that
    // call would throw with a SyntaxError and the user would see
    // the catch-all "Something went wrong" toast instead of the
    // throttle banner.
    setPasswordHandler = () =>
      new Response('', {
        status: 429,
        headers: { 'retry-after': '90' },
      });
    const user = userEvent.setup();
    renderPage();

    await fillAndSubmit(user);

    const alert = await screen.findByTestId('alert-set-password-throttled');
    expect(alert).toBeInTheDocument();
    // 90s rounds up to "2 minutes" via formatCountdown (ceil division).
    expect(screen.getByTestId('text-set-password-retry-in')).toHaveTextContent(/2 minutes/);
  });

  it('falls back to the default cooldown when a 429 ships no Retry-After / RateLimit-Reset headers', async () => {
    // Upstream load balancers occasionally swallow the
    // Retry-After header on 429s. The page must still paint a
    // throttle banner — the default fallback (300 seconds → "5
    // minutes") keeps the user from spamming submits during the
    // server-side window. Pinning this prevents a future refactor
    // from accidentally treating "no header" as "no throttle".
    setPasswordHandler = () =>
      new Response(JSON.stringify({ error: { message: 'Too many requests' } }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      });
    const user = userEvent.setup();
    renderPage();

    await fillAndSubmit(user);

    const alert = await screen.findByTestId('alert-set-password-throttled');
    expect(alert).toBeInTheDocument();
    expect(screen.getByTestId('text-set-password-retry-in')).toHaveTextContent(/5 minutes/);
    expect(screen.getByTestId('button-set-password-submit')).toBeDisabled();
  });

  it('does NOT show the throttle alert on a generic 400 validation error (no Retry-After)', async () => {
    setPasswordHandler = () =>
      new Response(
        JSON.stringify({ success: false, error: { message: 'Password too weak' } }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    const user = userEvent.setup();
    renderPage();

    await fillAndSubmit(user);

    await waitFor(() =>
      expect(screen.queryByTestId('alert-set-password-throttled')).not.toBeInTheDocument(),
    );
    // Submit should be re-enabled so the user can retry with a
    // different password.
    expect(screen.getByTestId('button-set-password-submit')).not.toBeDisabled();
  });
});

describe('SetPasswordPage preferred-language picker (task #420)', () => {
  // Capture every body the form posts so we can assert what
  // landed on the wire after each interaction.
  let capturedBody: Record<string, unknown> | null;

  beforeEach(() => {
    capturedBody = null;
    // Radix Select talks to the pointer-capture API which jsdom
    // doesn't ship; without these stubs userEvent.click on the
    // SelectTrigger throws "target.hasPointerCapture is not a
    // function" before any state change reaches the component.
    if (!Element.prototype.hasPointerCapture) {
      Element.prototype.hasPointerCapture = (() => false) as Element['hasPointerCapture'];
    }
    if (!Element.prototype.releasePointerCapture) {
      Element.prototype.releasePointerCapture = (() => undefined) as Element['releasePointerCapture'];
    }
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = (() => undefined) as Element['scrollIntoView'];
    }
    setPasswordHandler = async (_input, init) => {
      try {
        capturedBody = init?.body
          ? (JSON.parse(init.body as string) as Record<string, unknown>)
          : null;
      } catch {
        capturedBody = null;
      }
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
  });

  it('OMITS preferredLanguage from the body when the user never touches the picker', async () => {
    // CRITICAL regression guard: this page is the same landing
    // page the forgot-password reset flow sends users to. A
    // returning user with a stored language ('es') who resets
    // their password without touching the new picker MUST NOT
    // have their preference silently wiped to null. The server
    // treats a missing field as "leave the column alone" — but
    // that contract only holds if the client doesn't send the
    // field. Pinning this prevents a future refactor from
    // re-introducing the unconditional submit.
    const user = userEvent.setup();
    renderPage();

    await fillAndSubmit(user);

    await waitFor(() => expect(capturedBody).not.toBeNull());
    expect(capturedBody).toMatchObject({ password: STRONG_PASSWORD });
    expect(capturedBody && 'preferredLanguage' in capturedBody).toBe(false);
  });

  it('sends the chosen locale code when the user picks a language', async () => {
    // Brand-new invitee picks Spanish before clicking "Set
    // Password" — the wire payload must carry preferredLanguage:
    // 'es' so the server persists it AND uses it as the locale on
    // the very first onboarding email.
    const user = userEvent.setup();
    renderPage();

    const pwInput = await screen.findByLabelText(/^Password$/i);
    const confirmInput = await screen.findByLabelText(/confirm password/i);
    await user.type(pwInput, STRONG_PASSWORD);
    await user.type(confirmInput, STRONG_PASSWORD);

    // Open the language Select and click the Spanish option.
    await user.click(screen.getByTestId('select-set-password-language'));
    await user.click(await screen.findByTestId('option-set-password-language-es'));

    await user.click(screen.getByTestId('button-set-password-submit'));

    await waitFor(() => expect(capturedBody).not.toBeNull());
    expect(capturedBody).toMatchObject({ preferredLanguage: 'es' });
  });

  it('sends preferredLanguage: null when the user switches to a language and back to Auto', async () => {
    // Models a returning user who initially picks Spanish, then
    // changes their mind and clears it back to Auto before
    // submitting. The final wire value must be an explicit null —
    // that's the signal the server distinguishes from "field
    // omitted" and uses to CLEAR the stored column. (Radix Select
    // only fires onValueChange when the value actually changes,
    // so we can't test "click Auto when Auto is already
    // selected"; that path correctly stays untouched and would
    // omit the field.)
    const user = userEvent.setup();
    renderPage();

    const pwInput = await screen.findByLabelText(/^Password$/i);
    const confirmInput = await screen.findByLabelText(/confirm password/i);
    await user.type(pwInput, STRONG_PASSWORD);
    await user.type(confirmInput, STRONG_PASSWORD);

    await user.click(screen.getByTestId('select-set-password-language'));
    await user.click(await screen.findByTestId('option-set-password-language-es'));
    await user.click(screen.getByTestId('select-set-password-language'));
    await user.click(await screen.findByTestId('option-set-password-language-auto'));

    await user.click(screen.getByTestId('button-set-password-submit'));

    await waitFor(() => expect(capturedBody).not.toBeNull());
    expect(capturedBody).toHaveProperty('preferredLanguage', null);
  });
});

describe('SetPasswordPage validation and reset journey', () => {
  it('encodes the token and defaults a legacy success response to an invitation', async () => {
    testSearch = 'token=token%26with%20spaces';
    const requestedUrls: string[] = [];
    validateHandler = (input) => {
      requestedUrls.push(String(input));
      return new Response(JSON.stringify({ success: true, data: { email: 'l***@example.com' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    renderPage();

    expect(await screen.findByText(/Set Your Password/i)).toBeInTheDocument();
    expect(requestedUrls).toHaveLength(1);
    expect(requestedUrls[0]).toContain('token=token%26with+spaces');
    expect(screen.getByTestId('button-set-password-submit')).toHaveTextContent(/Set Password & Sign In/i);
  });

  it('renders reset-specific copy and sends reset users to login after success', async () => {
    validateHandler = () => new Response(JSON.stringify({
      success: true,
      data: { email: 'r***@example.com', action: 'password_reset' },
    }), { status: 200, headers: { 'content-type': 'application/json' } });

    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByText(/Reset Your Password/i)).toBeInTheDocument();
    await fillAndSubmit(user);

    await waitFor(() => expect(testMemoryLocation.history?.at(-1)).toBe('/login'));
  });

  it('routes registration users to login when password setup succeeds but auto-login fails', async () => {
    validateHandler = () => new Response(JSON.stringify({
      success: true,
      data: { email: 'r***@example.com', action: 'account_registration' },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    setPasswordHandler = () => new Response(JSON.stringify({
      success: true,
      data: { message: 'Password set successfully. Please log in.', loginFailed: true },
    }), { status: 200, headers: { 'content-type': 'application/json' } });

    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByText(/Finish Your Registration/i)).toBeInTheDocument();
    await fillAndSubmit(user);

    await waitFor(() => expect(testMemoryLocation.history?.at(-1)).toBe('/login'));
  });

  it('ignores a stale validation response after the URL changes', async () => {
    let resolveFirst!: (response: Response) => void;
    let resolveSecond!: (response: Response) => void;
    validateHandler = (input) => {
      const url = String(input);
      return new Promise<Response>((resolve) => {
        if (url.includes('first-token')) resolveFirst = resolve;
        else resolveSecond = resolve;
      });
    };

    testSearch = 'token=first-token';
    const view = renderPage();
    await waitFor(() => expect(resolveFirst).toBeTypeOf('function'));

    testSearch = 'token=second-token';
    view.rerenderPage();
    await waitFor(() => expect(resolveSecond).toBeTypeOf('function'));

    resolveSecond(new Response(JSON.stringify({
      success: true,
      data: { email: 's***@example.com', action: 'password_reset' },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    expect(await screen.findByText(/Reset Your Password/i)).toBeInTheDocument();

    resolveFirst(new Response(JSON.stringify({
      success: true,
      data: { email: 'f***@example.com', action: 'account_invite' },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await waitFor(() => expect(screen.getByText(/s\*\*\*@example\.com/)).toBeInTheDocument());
    expect(screen.queryByText(/f\*\*\*@example\.com/)).not.toBeInTheDocument();
  });

  it('shows a retryable temporary state for an offline validation error', async () => {
    let attempts = 0;
    validateHandler = () => {
      attempts += 1;
      if (attempts === 1) return Promise.reject(new TypeError('Failed to fetch'));
      return new Response(JSON.stringify({ success: true, data: { email: 'o***@example.com', action: 'account_invite' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByTestId('state-set-password-temporary')).toBeInTheDocument();
    await user.click(screen.getByTestId('button-set-password-validation-retry'));
    expect(await screen.findByText(/Set Your Password/i)).toBeInTheDocument();
    expect(attempts).toBe(2);
  });

  it('shows a retryable temporary state for a validation server error', async () => {
    let attempts = 0;
    validateHandler = () => {
      attempts += 1;
      if (attempts === 1) return new Response('', { status: 503 });
      return new Response(JSON.stringify({ success: true, data: { email: 'v***@example.com' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByTestId('state-set-password-temporary')).toBeInTheDocument();
    await user.click(screen.getByTestId('button-set-password-validation-retry'));
    expect(await screen.findByText(/Set Your Password/i)).toBeInTheDocument();
    expect(attempts).toBe(2);
  });

  it('honors Retry-After when validation is rate-limited', async () => {
    validateHandler = () => new Response('', {
      status: 429,
      headers: { 'retry-after': '61' },
    });
    renderPage();

    const state = await screen.findByTestId('state-set-password-throttled');
    expect(state).toHaveTextContent(/rate-limited/i);
    expect(screen.getByTestId('button-set-password-validation-retry')).toBeDisabled();
    expect(screen.getByTestId('button-set-password-validation-retry')).toHaveTextContent(/2 minutes/i);
  });

  it('moves to the expired state when the token expires between validation and submission', async () => {
    validateHandler = () => new Response(JSON.stringify({
      success: true,
      data: { email: 'e***@example.com', action: 'password_reset' },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    setPasswordHandler = () => new Response(JSON.stringify({
      success: false,
      error: { code: 'TOKEN_EXPIRED', message: 'expired' },
    }), { status: 400, headers: { 'content-type': 'application/json' } });

    const user = userEvent.setup();
    renderPage();
    await fillAndSubmit(user);

    expect(await screen.findByTestId('state-set-password-expired')).toBeInTheDocument();
    expect(screen.getByText(/This link has expired/i)).toBeInTheDocument();
  });

  it('keeps the form retryable after a submission server error', async () => {
    let attempts = 0;
    setPasswordHandler = () => {
      attempts += 1;
      if (attempts === 1) return new Response('', { status: 500 });
      return new Response(JSON.stringify({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Password rejected' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    };

    const user = userEvent.setup();
    renderPage();
    await fillAndSubmit(user);
    expect(await screen.findByTestId('alert-set-password-temporary')).toBeInTheDocument();
    expect(screen.getByTestId('button-set-password-submit')).not.toBeDisabled();
    await user.click(screen.getByTestId('button-set-password-submit'));
    await waitFor(() => expect(attempts).toBe(2));
    expect(screen.queryByTestId('alert-set-password-temporary')).not.toBeInTheDocument();
  });

  it('keeps the validated form visible for a password validation error from POST', async () => {
    setPasswordHandler = () => new Response(JSON.stringify({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Password rejected' },
    }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });

    const user = userEvent.setup();
    renderPage();
    await fillAndSubmit(user);

    expect(screen.getByTestId('state-set-password-ready')).toBeInTheDocument();
    expect(screen.getByTestId('button-set-password-submit')).not.toBeDisabled();
    expect(screen.queryByTestId('state-set-password-invalid')).not.toBeInTheDocument();
  });
});
