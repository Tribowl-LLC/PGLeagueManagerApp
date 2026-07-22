/**
 * Component test for the shared "Square isn't connected"
 * toast (task #391).
 *
 * Covers two behaviors that admin pages rely on:
 *   1. Triggering the toast renders the actionable
 *      "Square isn't connected for this location" title
 *      (instead of the legacy generic "something went wrong").
 *   2. The "Open Settings" action calls the provided wouter
 *      navigate function with the integrations deep-link, and
 *      respects an optional locationId query param.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { Toaster } from '@/components/ui/toaster';
import { useToast } from '@/hooks/use-toast';
import { apiRequest } from '@/lib/queryClient';
import {
  isProviderNotConfiguredError,
  makeApiError,
  providerNotConfiguredToast,
} from '@/lib/provider-not-configured';

function Trigger({
  navigate,
  locationId,
}: {
  navigate?: (path: string) => void;
  locationId?: number | null;
}) {
  const { toast } = useToast();
  return (
    <button
      type="button"
      onClick={() =>
        toast(providerNotConfiguredToast({ navigate, locationId }))
      }
      data-testid="fire-toast"
    >
      fire
    </button>
  );
}

describe('providerNotConfiguredToast', () => {
  it('renders the actionable title and Open Settings deep-link', async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();

    render(
      <>
        <Trigger navigate={navigate} />
        <Toaster />
      </>,
    );

    await user.click(screen.getByTestId('fire-toast'));

    expect(
      await screen.findByText(/Square isn't connected for this location/i),
    ).toBeInTheDocument();

    const action = await screen.findByRole('button', { name: /open settings/i });
    await user.click(action);

    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('/integrations');
  });

  it('appends the locationId query param when provided', async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();

    render(
      <>
        <Trigger navigate={navigate} locationId={42} />
        <Toaster />
      </>,
    );

    await user.click(screen.getByTestId('fire-toast'));
    await user.click(
      await screen.findByRole('button', { name: /open settings/i }),
    );

    expect(navigate).toHaveBeenCalledWith('/integrations?location=42');
  });

  it('uses bowler-facing Square copy when no navigate is provided', () => {
    const props = providerNotConfiguredToast({});
    expect(props.title).toBe("Square isn't connected for this location");
    expect(props.description).toBe(
      "Please ask your league admin to connect Square in Settings, then try again.",
    );
  });
});

describe('isProviderNotConfiguredError', () => {
  it('detects errors built from a 422 PROVIDER_NOT_CONFIGURED body', () => {
    const err = makeApiError(
      { error: { code: 'PROVIDER_NOT_CONFIGURED', message: 'nope' } },
      422,
      'fallback',
    );
    expect(isProviderNotConfiguredError(err)).toBe(true);
    expect((err as Error).message).toBe('nope');
  });

  it('still detects the code when nested in a JSON-encoded message (legacy square.ts path)', () => {
    const err = new Error(
      JSON.stringify({ error: { code: 'PROVIDER_NOT_CONFIGURED', message: 'x' } }),
    );
    expect(isProviderNotConfiguredError(err)).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(isProviderNotConfiguredError(new Error('boom'))).toBe(false);
    expect(isProviderNotConfiguredError(null)).toBe(false);
  });
});

describe('apiRequest -> isProviderNotConfiguredError integration', () => {
  // Locks in the wiring used by every admin mutation that goes
  // through apiRequest (refunds, save card, customers, charges,
  // Apple Pay job retry/cancel) — a 422 PROVIDER_NOT_CONFIGURED
  // body must produce an Error that the shared helper detects so
  // the actionable toast fires instead of "Refund Failed: ...".
  it('detects PROVIDER_NOT_CONFIGURED errors thrown from a 422 apiRequest', async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/csrf-token')) {
        // apiRequest calls csrfFetch first which fetches a token —
        // satisfy that handshake so the test exercises the real
        // refund-style path.
        return new Response(
          JSON.stringify({ success: true, data: { token: 'test-token' } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          success: false,
          error: { code: 'PROVIDER_NOT_CONFIGURED', message: 'Square not connected' },
        }),
        { status: 422, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    try {
      await expect(apiRequest('/api/payments/123/refund', 'POST', { reason: 'x' }))
        .rejects.toSatisfy((err: unknown) => isProviderNotConfiguredError(err));
    } finally {
      global.fetch = originalFetch;
    }
  });
});
