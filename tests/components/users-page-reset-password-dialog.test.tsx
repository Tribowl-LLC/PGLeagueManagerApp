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
  bowlerId: null,
  createdAt: '2026-01-01T00:00:00Z',
  linkedBowler: null,
};

type ResetHandler = (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>;

const originalFetch = global.fetch;
let resetHandler: ResetHandler;
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
    if (url.includes(`/api/org-admin/users/${TARGET.id}/reset-password`)) {
      try {
        postedBody = init?.body ? JSON.parse(init.body as string) : null;
      } catch {
        postedBody = init?.body ?? null;
      }
      return resetHandler(input, init);
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

const STRONG_PASSWORD = 'StrongPw1!2026';
const WEAK_PASSWORD = 'short';

beforeEach(() => {
  toastFn.mockReset();
  clearCsrfToken();
  installFetchMock();
  // Default handler: success.
  resetHandler = () => jsonRes({ success: true, data: null });
});

afterEach(() => {
  global.fetch = originalFetch;
});

async function openResetDialogFor(targetId: number, user: ReturnType<typeof userEvent.setup>) {
  const btn = await screen.findByTestId(`button-reset-password-${targetId}`);
  await user.click(btn);
  return await screen.findByTestId('input-reset-password');
}

describe('UsersPage — Reset Password dialog', () => {
  it('shows a validation error and never POSTs when the password is too weak', async () => {
    const user = userEvent.setup();
    renderPage();
    const input = await openResetDialogFor(TARGET.id, user);
    await user.type(input, WEAK_PASSWORD);
    await user.click(screen.getByTestId('button-confirm-reset-password'));

    await waitFor(() => {
      expect(input).toHaveAttribute('aria-invalid', 'true');
    });
    expect(postedBody).toBeNull();
    expect(screen.getByTestId('input-reset-password')).toBeInTheDocument();
  });

  it('POSTs a strong password, closes the dialog, and shows a success toast', async () => {
    const user = userEvent.setup();
    renderPage();
    const input = await openResetDialogFor(TARGET.id, user);
    await user.type(input, STRONG_PASSWORD);
    await user.click(screen.getByTestId('button-confirm-reset-password'));

    await waitFor(() => {
      expect(postedBody).toEqual({ newPassword: STRONG_PASSWORD });
    });
    await waitFor(() => {
      expect(screen.queryByTestId('input-reset-password')).toBeNull();
    });
    expect(toastFn).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringMatching(/password reset/i) }),
    );
  });

  it('keeps the dialog open and shows a destructive toast when the backend rejects', async () => {
    resetHandler = () =>
      jsonRes(
        { success: false, error: { message: 'Cannot reset your own password here.' } },
        400,
      );
    const user = userEvent.setup();
    renderPage();
    const input = await openResetDialogFor(TARGET.id, user);
    await user.type(input, STRONG_PASSWORD);
    await user.click(screen.getByTestId('button-confirm-reset-password'));

    await waitFor(() => {
      expect(toastFn).toHaveBeenCalledWith(
        expect.objectContaining({ variant: 'destructive' }),
      );
    });
    expect(screen.getByTestId('input-reset-password')).toBeInTheDocument();
  });
});
