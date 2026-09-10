/**
 * Regression coverage for the authenticated email-confirmation response
 * where the email transaction committed but Passport could not persist the
 * refreshed session. The page must retain the completed outcome and route
 * through the shared fresh-login redirect instead of presenting a retryable
 * failure.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';

vi.mock('@/lib/queryClient', async () => {
  const actual = await vi.importActual<typeof import('../../client/src/lib/queryClient')>(
    '../../client/src/lib/queryClient',
  );
  return {
    ...actual,
    redirectToLoginForExpiredSession: vi.fn(),
  };
});

import { redirectToLoginForExpiredSession } from '@/lib/queryClient';
import ConfirmEmailChangePage from '@/pages/confirm-email-change-page';

const mockedRedirectToLogin = vi.mocked(redirectToLoginForExpiredSession);
const originalFetch = global.fetch;
const testMemoryLocation = memoryLocation({ path: '/confirm-email-change', record: true });
const { hook: memoryHook } = testMemoryLocation;
let testSearch = 'token=confirmed-email-token';

function useTestSearch(): string {
  return testSearch;
}

beforeEach(() => {
  testSearch = 'token=confirmed-email-token';
  testMemoryLocation.reset?.();
  mockedRedirectToLogin.mockReset();
  global.fetch = async (_input, _init) => new Response(JSON.stringify({
    success: true,
    data: {
      email: 'new-address@example.com',
      paymentSyncStatus: 'not_applicable',
      requiresLogin: true,
    },
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe('ConfirmEmailChangePage session-refresh failure', () => {
  it('shows the completed email change and routes through fresh login', async () => {
    render(
      <Router hook={memoryHook} searchHook={useTestSearch}>
        <ConfirmEmailChangePage />
      </Router>,
    );

    expect(await screen.findByText('Email updated')).toBeInTheDocument();
    expect(screen.getByText(/your sign-in email is now/i)).toHaveTextContent(
      'Your sign-in email is now new-address@example.com. Please log in again to continue.',
    );
    await waitFor(() => expect(mockedRedirectToLogin).toHaveBeenCalledWith({
      cachedAuthenticated: true,
      force: true,
      reason: 'credential-changed',
    }));
  });
});
