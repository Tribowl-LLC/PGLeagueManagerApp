/**
 * Task #349: pin the four rendering branches of the new
 * "Confirmation email" row inside `ExecutionSummaryPanel` on the
 * deletion-requests admin page.
 *
 * Branches under test:
 *   - suppressedByUser=true        -> "suppressed by user choice"
 *   - sent=true                    -> "sent"
 *   - sent=false + error string    -> "failed to send — <error>"
 *   - confirmationEmail=undefined  -> "not recorded (legacy run)"
 *
 * The legacy branch is the most important: older audit summaries
 * written before this task lack the confirmationEmail field, and the
 * panel must NOT pretend they were sent.
 */
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

function summaryWith(
  confirmationEmail: DeletionExecutionSummary['confirmationEmail'],
): DeletionExecutionSummary {
  return {
    executedAt: '2026-04-22T15:34:56.789Z',
    executedBy: 7,
    email: 'gone@example.com',
    user: { deleted: true, userId: 42 },
    bowlers: [
      { bowlerId: 100, anonymized: true, hadPaymentCustomerId: false },
    ],
    paymentProvider: [],
    emailChangeRequestsDeleted: 0,
    confirmationEmail,
  };
}

function rowWithSummary(summary: DeletionExecutionSummary | { __omitConfirmationEmail: true }) {
  // For the legacy branch we deliberately serialize a summary that
  // does NOT contain a `confirmationEmail` key, mirroring rows
  // written before task #349 shipped.
  const payload =
    '__omitConfirmationEmail' in summary
      ? JSON.stringify({
          executedAt: '2026-04-22T15:34:56.789Z',
          executedBy: 7,
          email: 'gone@example.com',
          user: { deleted: true, userId: 42 },
          bowlers: [
            {
              bowlerId: 100,
              anonymized: true,
              hadPaymentCustomerId: false,
            },
          ],
          paymentProvider: [],
          emailChangeRequestsDeleted: 0,
        })
      : JSON.stringify(summary);
  return {
    id: 999,
    email: 'gone@example.com',
    reason: 'gdpr',
    status: 'completed',
    adminNote: null,
    reviewedBy: 7,
    reviewedAt: '2026-04-22T15:34:56.789Z',
    ipAddress: null,
    userAgent: null,
    executionSummary: payload,
    createdAt: '2026-04-21T10:00:00.000Z',
  };
}

const originalFetch = global.fetch;

function mockFetchWithRow(row: ReturnType<typeof rowWithSummary>) {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/system-admin/deletion-requests')) {
      return new Response(JSON.stringify({ success: true, data: [row] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  toastMock.mockClear();
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

async function openPanel(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('tab', { name: /completed/i }));
  await waitFor(() =>
    expect(screen.getByTestId('deletion-request-row-999')).toBeInTheDocument(),
  );
  await user.click(screen.getByTestId('toggle-summary-999'));
  return await screen.findByTestId('confirmation-email-status-999');
}

describe('Deletion requests · confirmation-email status (task #349)', () => {
  it('renders "suppressed by user choice" when the requester opted out', async () => {
    mockFetchWithRow(
      rowWithSummary(summaryWith({ sent: false, suppressedByUser: true })),
    );
    const user = userEvent.setup();

    renderPage();
    const status = await openPanel(user);

    expect(status).toHaveTextContent(/suppressed by user choice/i);
    expect(status).not.toHaveTextContent(/failed to send/i);
    expect(status).not.toHaveTextContent(/^sent$/i);
  });

  it('renders "sent" when the SendGrid call succeeded', async () => {
    mockFetchWithRow(
      rowWithSummary(summaryWith({ sent: true, suppressedByUser: false })),
    );
    const user = userEvent.setup();

    renderPage();
    const status = await openPanel(user);

    expect(status).toHaveTextContent(/sent/i);
    expect(status).not.toHaveTextContent(/suppressed/i);
    expect(status).not.toHaveTextContent(/failed/i);
    expect(status).not.toHaveTextContent(/legacy/i);
  });

  it('renders "failed to send" with the captured error when the send threw', async () => {
    mockFetchWithRow(
      rowWithSummary(
        summaryWith({
          sent: false,
          suppressedByUser: false,
          error: 'SendGrid 502 Bad Gateway',
        }),
      ),
    );
    const user = userEvent.setup();

    renderPage();
    const status = await openPanel(user);

    expect(status).toHaveTextContent(/failed to send/i);
    expect(status).toHaveTextContent(/SendGrid 502 Bad Gateway/);
    expect(status).not.toHaveTextContent(/suppressed/i);
  });

  it('renders the neutral "not recorded (legacy run)" pill when the field is absent', async () => {
    mockFetchWithRow(rowWithSummary({ __omitConfirmationEmail: true }));
    const user = userEvent.setup();

    renderPage();
    const status = await openPanel(user);

    expect(status).toHaveTextContent(/not recorded \(legacy run\)/i);
    // Critically, the legacy branch must NOT claim the email was sent
    // — the whole reason this branch exists is so we don't fabricate
    // a misleading status for rows written before the field existed.
    expect(status).not.toHaveTextContent(/^sent$/i);
    expect(status).not.toHaveTextContent(/suppressed/i);
    expect(status).not.toHaveTextContent(/failed to send/i);
  });
});
