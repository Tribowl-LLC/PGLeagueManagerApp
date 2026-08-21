import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/components/layout', () => ({
  Layout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const toastFn = vi.fn();
vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: toastFn }),
}));

import UsersPage from '@/pages/users-page';
import { clearCsrfToken, getQueryFn } from '@/lib/queryClient';

const ADMIN = {
  id: 1,
  email: 'admin@example.com',
  name: 'Org Admin',
  role: 'org_admin',
  organizationId: 7,
  locationId: null,
  bowlerId: null,
  createdAt: '2026-01-01T00:00:00Z',
  linkedBowler: null,
};

const TARGET = {
  id: 100,
  email: 'pat@example.com',
  name: 'Pat Bowler',
  role: 'user',
  organizationId: 7,
  locationId: null,
  bowlerId: 42,
  createdAt: '2026-01-01T00:00:00Z',
  linkedBowler: null,
};

type ProfileHandler = (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>;

const originalFetch = global.fetch;
let profileHandler: ProfileHandler;
let postedBody: unknown = null;

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function installFetchMock() {
  postedBody = null;
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();

    if (url.includes('/api/csrf-token')) {
      return jsonRes({ success: true, data: { token: 'test-csrf' } });
    }
    if (url.endsWith('/api/user')) {
      return jsonRes({ success: true, data: ADMIN });
    }
    if (url.startsWith('/api/org-admin/users?organizationId=')) {
      return jsonRes({ success: true, data: [TARGET] });
    }
    if (url.endsWith('/api/locations')) {
      return jsonRes({ success: true, data: [] });
    }
    if (url.includes(`/api/account/profile/${TARGET.id}`)) {
      try {
        postedBody = init?.body ? JSON.parse(init.body as string) : null;
      } catch {
        postedBody = init?.body ?? null;
      }
      return profileHandler(input, init);
    }
    return jsonRes({ success: false, error: { message: `unmocked: ${url}` } }, 500);
  }) as unknown as typeof fetch;
}

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { queryFn: getQueryFn, retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <UsersPage />
    </QueryClientProvider>,
  );
}

const NEW_EMAIL = 'pat-new@example.com';

beforeEach(() => {
  toastFn.mockReset();
  clearCsrfToken();
  installFetchMock();
  profileHandler = () =>
    jsonRes({ success: true, data: { paymentSyncStatus: 'not_applicable' } });
});

afterEach(() => {
  global.fetch = originalFetch;
});

async function openChangeEmailDialogFor(targetId: number, user: ReturnType<typeof userEvent.setup>) {
  const btn = await screen.findByTestId(`button-change-email-${targetId}`);
  await user.click(btn);
  return await screen.findByTestId('input-change-email');
}

describe('UsersPage — Change Email dialog', () => {
  it('PATCHes the new email, closes the dialog, and shows a confirmation toast', async () => {
    const user = userEvent.setup();
    renderPage();
    const input = await openChangeEmailDialogFor(TARGET.id, user);
    await user.type(input, NEW_EMAIL);
    await user.click(screen.getByTestId('button-confirm-change-email'));

    await waitFor(() => {
      expect(postedBody).toEqual({ email: NEW_EMAIL });
    });
    await waitFor(() => {
      expect(screen.queryByTestId('input-change-email')).toBeNull();
    });
    expect(toastFn).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringMatching(/confirmation email sent/i) }),
    );
    // No retry notice for `not_applicable`.
    expect(toastFn).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Payment record will be retried' }),
    );
  });

  it('also shows the verbatim "Payment record will be retried" toast on pending_retry', async () => {
    profileHandler = () =>
      jsonRes({ success: true, data: { paymentSyncStatus: 'pending_retry' } });
    const user = userEvent.setup();
    renderPage();
    const input = await openChangeEmailDialogFor(TARGET.id, user);
    await user.type(input, NEW_EMAIL);
    await user.click(screen.getByTestId('button-confirm-change-email'));

    await waitFor(() => {
      expect(toastFn).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Payment record will be retried',
          description:
            'Your payment profile is temporarily out of date and will be retried automatically. Charges or saved cards may behave oddly for the next few minutes.',
        }),
      );
    });
  });

  it('does not show the retry toast for synced or skipped statuses', async () => {
    for (const status of ['synced', 'skipped'] as const) {
      toastFn.mockReset();
      profileHandler = () =>
        jsonRes({ success: true, data: { paymentSyncStatus: status } });
      const user = userEvent.setup();
      const { unmount } = renderPage();
      const input = await openChangeEmailDialogFor(TARGET.id, user);
      await user.type(input, NEW_EMAIL);
      await user.click(screen.getByTestId('button-confirm-change-email'));

      await waitFor(() => {
        expect(toastFn).toHaveBeenCalledWith(
          expect.objectContaining({ title: expect.stringMatching(/confirmation email sent/i) }),
        );
      });
      expect(toastFn).not.toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Payment record will be retried' }),
      );
      unmount();
    }
  });

  it('shows an inline validation error and does NOT fire a PATCH for an invalid email', async () => {
    const user = userEvent.setup();
    renderPage();
    const input = await openChangeEmailDialogFor(TARGET.id, user);
    await user.type(input, 'not-an-email');
    await user.click(screen.getByTestId('button-confirm-change-email'));

    expect(await screen.findByText(/please enter a valid email/i)).toBeInTheDocument();

    // Give any (incorrectly fired) mutation a tick to settle, then assert no PATCH happened.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(postedBody).toBeNull();
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const profileCalls = fetchMock.mock.calls.filter(([url]) => {
      const u = typeof url === 'string' ? url : url.toString();
      return u.includes(`/api/account/profile/${TARGET.id}`);
    });
    expect(profileCalls).toHaveLength(0);

    // Dialog stays open and no success toast was shown.
    expect(screen.getByTestId('input-change-email')).toBeInTheDocument();
    expect(toastFn).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringMatching(/confirmation email sent/i) }),
    );
  });

  it('keeps the dialog open and shows a destructive toast when the backend rejects', async () => {
    profileHandler = () =>
      jsonRes(
        { success: false, error: { message: 'Email already in use' } },
        400,
      );
    const user = userEvent.setup();
    renderPage();
    const input = await openChangeEmailDialogFor(TARGET.id, user);
    await user.type(input, NEW_EMAIL);
    await user.click(screen.getByTestId('button-confirm-change-email'));

    await waitFor(() => {
      expect(toastFn).toHaveBeenCalledWith(
        expect.objectContaining({ variant: 'destructive' }),
      );
    });
    expect(screen.getByTestId('input-change-email')).toBeInTheDocument();
  });
});
