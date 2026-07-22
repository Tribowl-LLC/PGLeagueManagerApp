import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
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

const summary: DeletionExecutionSummary = {
  executedAt: '2026-04-22T15:34:56.789Z',
  executedBy: 7,
  email: 'gone@example.com',
  user: { deleted: true, userId: 42 },
  bowlers: [
    { bowlerId: 100, anonymized: true, hadPaymentCustomerId: true },
    {
      bowlerId: 101,
      anonymized: false,
      hadPaymentCustomerId: false,
      reason: 'locked by active session',
    },
  ],
  paymentProvider: [
    { locationId: 1, providerName: 'stripe', customerId: 'cus_abc', deleted: true },
  ],
  emailChangeRequestsDeleted: 0,
};

const completedRow = {
  id: 999,
  email: 'gone@example.com',
  reason: 'gdpr',
  status: 'completed',
  adminNote: null,
  reviewedBy: 7,
  reviewedAt: '2026-04-22T15:34:56.789Z',
  ipAddress: null,
  userAgent: null,
  executionSummary: JSON.stringify(summary),
  createdAt: '2026-04-21T10:00:00.000Z',
};

const originalFetch = global.fetch;
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

function mockFetchWithRow(row: typeof completedRow) {
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
  mockFetchWithRow(completedRow);
});

afterEach(() => {
  global.fetch = originalFetch;
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
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

async function openExecutionDetails(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('tab', { name: /completed/i }));
  await waitFor(() =>
    expect(screen.getByTestId('deletion-request-row-999')).toBeInTheDocument(),
  );
  await user.click(screen.getByTestId('toggle-summary-999'));
  return await screen.findByTestId('execution-summary-panel');
}

function findToastByTitle(pattern: RegExp) {
  return toastMock.mock.calls.find((c) =>
    pattern.test((c[0] as { title?: string }).title ?? ''),
  )?.[0] as { title?: string; description?: string; variant?: string } | undefined;
}

describe('Deletion requests · execution-summary export (task #347)', () => {
  it('Copy JSON writes the parsed summary verbatim to the clipboard', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();

    renderPage();
    await openExecutionDetails(user);
    await user.click(screen.getByTestId('button-copy-summary-999'));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const written = writeText.mock.calls[0]![0] as string;
    // Two-space indented JSON — the contract for compliance pasting.
    expect(written.split('\n')[1]).toMatch(/^ {2}"/);
    expect(JSON.parse(written)).toEqual(summary);

    await waitFor(() => {
      const success = findToastByTitle(/copied execution summary/i);
      expect(success).toBeDefined();
      expect(success!.variant).toBeUndefined();
    });
  });

  it('shows a destructive toast when navigator.clipboard is undefined', async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });

    renderPage();
    await openExecutionDetails(user);
    await user.click(screen.getByTestId('button-copy-summary-999'));

    await waitFor(() => {
      const failure = findToastByTitle(/copy failed/i);
      expect(failure).toBeDefined();
      expect(failure!.description).toMatch(/clipboard api unavailable/i);
    });
  });

  it('shows a destructive toast when navigator.clipboard.writeText rejects', async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(
      new Error('Document is not focused'),
    );

    renderPage();
    await openExecutionDetails(user);
    await user.click(screen.getByTestId('button-copy-summary-999'));

    await waitFor(() => {
      const failure = findToastByTitle(/copy failed/i);
      expect(failure).toBeDefined();
      expect(failure!.variant).toBe('destructive');
    });
  });

  it('Download .json triggers an anchor click with a request-keyed filename', async () => {
    const createObjectURL = vi.fn(() => 'blob:mock-url');
    const revokeObjectURL = vi.fn();
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;

    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    const user = userEvent.setup();
    renderPage();
    const panel = await openExecutionDetails(user);

    await user.click(within(panel).getByTestId('button-download-summary-999'));

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);

    const anchor = clickSpy.mock.instances[0] as HTMLAnchorElement;
    expect(anchor.download).toMatch(/^deletion-request-999-/);
    expect(anchor.download).toMatch(/\.json$/);
    // Stem (filename minus the .json extension) must contain neither `:` nor
    // `.` so the file lands cleanly on Windows / SharePoint.
    const stem = anchor.download.replace(/\.json$/, '');
    expect(stem).not.toMatch(/[:.]/);
    expect(stem).toContain('2026-04-22T15-34-56-789Z');

    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url'));
  });

  it('falls back to a current-time stamp when executedAt is missing on a legacy row', async () => {
    mockFetchWithRow({
      ...completedRow,
      executionSummary: JSON.stringify({ ...summary, executedAt: '' }),
    });

    URL.createObjectURL = vi.fn(() => 'blob:legacy');
    URL.revokeObjectURL = vi.fn();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    const user = userEvent.setup();
    renderPage();
    const panel = await openExecutionDetails(user);

    await user.click(within(panel).getByTestId('button-download-summary-999'));

    expect(clickSpy).toHaveBeenCalledTimes(1);
    const anchor = clickSpy.mock.instances[0] as HTMLAnchorElement;
    expect(anchor.download).toMatch(/^deletion-request-999-/);
    expect(anchor.download).toMatch(/\.json$/);
    expect(anchor.download).not.toMatch(/undefined|null|NaN/);
    const stem = anchor.download.replace(/\.json$/, '');
    expect(stem).not.toMatch(/[:.]/);
  });
});
