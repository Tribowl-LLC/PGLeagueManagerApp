import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import DeletionRequestsPage from '@/pages/deletion-requests-page';
import type { DeletionExecutionSummary } from '@shared/schema';

vi.mock('@/components/layout', () => ({
  Layout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const { toastMock } = vi.hoisted(() => ({ toastMock: vi.fn() }));
vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: toastMock, dismiss: vi.fn(), toasts: [] }),
}));

function summary(opts: { providerDeleted: boolean; bowlerId?: number }): DeletionExecutionSummary {
  return {
    executedAt: '2026-04-22T15:34:56.789Z',
    executedBy: 7,
    email: 'gone@example.com',
    user: { deleted: true, userId: 42 },
    bowlers: [
      {
        bowlerId: opts.bowlerId ?? 1,
        anonymized: true,
        hadPaymentCustomerId: true,
      },
    ],
    paymentProvider: [
      {
        locationId: 1,
        providerName: 'stripe',
        customerId: 'cus_x',
        deleted: opts.providerDeleted,
        ...(opts.providerDeleted ? {} : { error: 'card vault timeout' }),
      },
    ],
    emailChangeRequestsDeleted: 0,
  };
}

function row(id: number, providerDeleted: boolean) {
  return {
    id,
    email: `r${id}@example.com`,
    reason: 'gdpr',
    status: 'completed',
    adminNote: null,
    reviewedBy: 7,
    reviewedAt: '2026-04-22T15:34:56.789Z',
    ipAddress: null,
    userAgent: null,
    executionSummary: JSON.stringify(summary({ providerDeleted, bowlerId: id })),
    createdAt: '2026-04-21T10:00:00.000Z',
  };
}

const ROWS = [
  row(101, true),
  row(102, false),
  row(103, true),
  row(104, false),
];

const originalFetch = global.fetch;

beforeEach(() => {
  toastMock.mockClear();
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/system-admin/deletion-requests')) {
      return new Response(JSON.stringify({ success: true, data: ROWS }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <DeletionRequestsPage />
    </QueryClientProvider>,
  );
}

async function gotoCompleted(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('tab', { name: /completed/i }));
  await waitFor(() =>
    expect(screen.getByTestId('deletion-request-row-101')).toBeInTheDocument(),
  );
}

describe('Deletion requests · provider-failure filter (task #348)', () => {
  it('shows the toggle only on the Completed tab', async () => {
    const user = userEvent.setup();
    renderPage();

    // Pending tab on initial load — no toggle.
    expect(screen.queryByTestId('switch-provider-failures-only')).not.toBeInTheDocument();

    await gotoCompleted(user);
    expect(screen.getByTestId('switch-provider-failures-only')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /rejected/i }));
    await waitFor(() =>
      expect(screen.queryByTestId('switch-provider-failures-only')).not.toBeInTheDocument(),
    );
  });

  it('filters the completed list down to rows with at least one provider failure', async () => {
    const user = userEvent.setup();
    renderPage();
    await gotoCompleted(user);

    // All four rows visible before toggling.
    expect(screen.getByTestId('text-requests-count')).toHaveTextContent(/Completed requests \(4\)/);
    for (const id of [101, 102, 103, 104]) {
      expect(screen.getByTestId(`deletion-request-row-${id}`)).toBeInTheDocument();
    }

    await user.click(screen.getByTestId('switch-provider-failures-only'));

    // Only rows 102 and 104 (providerDeleted: false) should remain.
    await waitFor(() =>
      expect(screen.getByTestId('text-requests-count')).toHaveTextContent(
        /with provider failures \(2 of 4\)/i,
      ),
    );
    expect(screen.getByTestId('deletion-request-row-102')).toBeInTheDocument();
    expect(screen.getByTestId('deletion-request-row-104')).toBeInTheDocument();
    expect(screen.queryByTestId('deletion-request-row-101')).not.toBeInTheDocument();
    expect(screen.queryByTestId('deletion-request-row-103')).not.toBeInTheDocument();
  });

  it('shows the empty state when no completed rows have provider failures', async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/system-admin/deletion-requests')) {
        return new Response(
          JSON.stringify({ success: true, data: [row(201, true), row(202, true)] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('tab', { name: /completed/i }));
    await waitFor(() =>
      expect(screen.getByTestId('deletion-request-row-201')).toBeInTheDocument(),
    );

    await user.click(screen.getByTestId('switch-provider-failures-only'));

    await waitFor(() =>
      expect(screen.getByTestId('text-requests-count')).toHaveTextContent(/0 of 2/),
    );
    expect(screen.queryByTestId('deletion-request-row-201')).not.toBeInTheDocument();
    expect(screen.getByText(/no completed deletion requests/i)).toBeInTheDocument();
  });

  it('treats rows with malformed or missing executionSummary as not matching', async () => {
    // A legacy row with no executionSummary at all (executor never ran)
    // must not slip through the sweep filter — the admin is looking
    // for *known* provider failures, and "we never executed" is a
    // different problem class entirely.
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/system-admin/deletion-requests')) {
        const malformedRow = { ...row(301, false), executionSummary: 'not-json' };
        const noSummaryRow = { ...row(302, false), executionSummary: null };
        return new Response(
          JSON.stringify({ success: true, data: [malformedRow, noSummaryRow, row(303, false)] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('tab', { name: /completed/i }));
    await waitFor(() =>
      expect(screen.getByTestId('deletion-request-row-303')).toBeInTheDocument(),
    );

    await user.click(screen.getByTestId('switch-provider-failures-only'));

    await waitFor(() =>
      expect(screen.getByTestId('text-requests-count')).toHaveTextContent(/1 of 3/),
    );
    expect(screen.getByTestId('deletion-request-row-303')).toBeInTheDocument();
    expect(screen.queryByTestId('deletion-request-row-301')).not.toBeInTheDocument();
    expect(screen.queryByTestId('deletion-request-row-302')).not.toBeInTheDocument();
  });
});
