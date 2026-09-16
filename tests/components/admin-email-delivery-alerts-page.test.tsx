import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AdminEmailDeliveryAlertsPage from '@/pages/admin-email-delivery-alerts-page';

vi.mock('@/components/layout', () => ({
  Layout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const { toastMock } = vi.hoisted(() => ({ toastMock: vi.fn() }));
vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: toastMock, dismiss: vi.fn(), toasts: [] }),
}));

const originalFetch = global.fetch;

const pendingAlert = {
  id: 7001,
  recipientEmail: 'recipient@example.com',
  eventType: 'bounce',
  failureType: 'bounce',
  reasonCode: 'recipient_address_invalid',
  bounceClassification: 'frequency_volume',
  smtpStatus: '550',
  sendingIp: '198.51.100.10',
  providerEventAt: '2026-09-16T09:00:00.000Z',
  receivedAt: '2026-09-16T09:00:02.000Z',
  acknowledgedAt: null,
} as const;

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AdminEmailDeliveryAlertsPage />
    </QueryClientProvider>,
  );
}

describe('AdminEmailDeliveryAlertsPage', () => {
  beforeEach(() => {
    toastMock.mockClear();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('renders pending failures with safe labels and a not-connected notice', async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/system-admin/email-delivery-alerts')) {
        return new Response(JSON.stringify({
          success: true,
          data: {
            alerts: [pendingAlert],
            unacknowledgedCount: 1,
            webhookConfigured: false,
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 404 });
    });

    renderPage();

    const row = await screen.findByTestId(`delivery-alert-row-${pendingAlert.id}`);
    expect(row).toHaveTextContent('recipient@example.com');
    expect(row).toHaveTextContent('Recipient address is invalid');
    expect(row).toHaveTextContent('198.51.100.10');
    expect(row).toHaveTextContent('SMTP 550');
    expect(row).toHaveTextContent('Frequency/volume');
    expect(screen.getByTestId('delivery-alerts-webhook-not-configured')).toBeInTheDocument();
    expect(screen.queryByText('provider reason text')).not.toBeInTheDocument();
  });

  it('acknowledges a pending failure and removes it from the pending queue', async () => {
    const user = userEvent.setup();
    let acknowledged = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/csrf-token')) {
        return new Response(JSON.stringify({ success: true, data: { token: 'test-csrf-token' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith(`/api/system-admin/email-delivery-alerts/${pendingAlert.id}/acknowledge`)) {
        acknowledged = true;
        expect(init?.method).toBe('POST');
        return new Response(JSON.stringify({ success: true, data: { alert: pendingAlert } }), { status: 200 });
      }
      if (url.includes('/api/system-admin/email-delivery-alerts')) {
        return new Response(JSON.stringify({
          success: true,
          data: {
            alerts: acknowledged ? [] : [pendingAlert],
            unacknowledgedCount: acknowledged ? 0 : 1,
            webhookConfigured: true,
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 404 });
    });
    global.fetch = fetchMock;

    renderPage();
    await user.click(await screen.findByTestId(`button-acknowledge-delivery-alert-${pendingAlert.id}`));

    await waitFor(() => {
      expect(screen.getByTestId('delivery-alerts-empty')).toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/system-admin/email-delivery-alerts/${pendingAlert.id}/acknowledge`,
        expect.objectContaining({ method: 'POST' }),
      );
    });
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'Alert acknowledged' }));
  });
});
