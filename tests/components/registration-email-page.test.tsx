import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getQueryFn, queryClient as appQueryClient } from "@/lib/queryClient";

const { apiRequestMock, navigateMock, captureException } = vi.hoisted(() => ({
  apiRequestMock: vi.fn(), navigateMock: vi.fn(), captureException: vi.fn(),
}));
vi.mock('@sentry/react', async (importOriginal) => ({
  ...await importOriginal<typeof import('@sentry/react')>(), captureException,
}));
vi.mock('wouter', async (importOriginal) => ({
  ...await importOriginal<typeof import('wouter')>(), useLocation: () => ['/registration-email', navigateMock],
}));
vi.mock("@/lib/queryClient", async () => {
  const actual = await vi.importActual<typeof import("@/lib/queryClient")>("@/lib/queryClient");
  return { ...actual, apiRequest: apiRequestMock };
});

import RegistrationEmailPage from "@/pages/registration-email-page";

const clients: QueryClient[] = [];
function renderPage(client?: QueryClient) {
  const queryClient = client ?? new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(queryClient);
  return render(
    <QueryClientProvider client={queryClient}>
      <RegistrationEmailPage />
    </QueryClientProvider>,
  );
}

function statusData(overrides: Record<string, unknown> = {}) {
  return {
    status: "pending",
    email: "r***@example.com",
    actionStatus: "revoked",
    deliveryStatus: "failed",
    deliveryJobStatus: "failed",
    deliveryLastErrorCode: "provider_rejected",
    ...overrides,
  };
}

beforeEach(() => {
  apiRequestMock.mockReset();
  navigateMock.mockReset();
  captureException.mockReset();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});
const missing = () => json({ error: { code: 'NOT_FOUND', message: 'Registration status is unavailable.' } }, 404);
const anonymous = () => json({ error: { code: 'AUTH_REQUIRED', message: 'Authentication required' } }, 401);
afterEach(() => {
  clients.splice(0).forEach((client) => client.clear());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("RegistrationEmailPage delivery states", () => {
  it("uses neutral recovery actions when the server has no registration capability", async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url === '/api/user' ? anonymous() : missing()));
    renderPage();

    expect(await screen.findByText("Continue registration", { exact: true })).toBeInTheDocument();
    expect(screen.getByTestId("link-registration-continue")).toHaveTextContent("Continue sign-up");
    expect(screen.getByTestId("link-registration-sign-in")).toHaveTextContent("Sign in");
    expect(screen.getByTestId("link-registration-forgot-password")).toHaveTextContent("Forgot password?");
    expect(screen.queryByText(/session is no longer available/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/different email/i)).not.toBeInTheDocument();
  });

  it("shows a confirmed delivery failure while the pending account remains actionable", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ success: true, data: statusData() })));
    renderPage();

    expect(await screen.findByText("Check your email", { exact: true })).toBeInTheDocument();
    expect(screen.getByTestId("registration-delivery-status")).toHaveTextContent("Delivery failed");
    expect(screen.queryByText("Registration status unavailable")).not.toBeInTheDocument();
    expect(screen.getByTestId("button-registration-resend")).toBeEnabled();
  });

  it("does not turn an uncertain retry into a confirmed bad-address failure", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({
      success: true,
      data: statusData({
        actionStatus: "pending",
        deliveryStatus: "unknown",
        deliveryJobStatus: "retry_scheduled",
        deliveryLastErrorCode: "provider_error",
      }),
    })));
    renderPage();

    expect(await screen.findByText("Check your email", { exact: true })).toBeInTheDocument();
    expect(screen.getByTestId("registration-delivery-status")).toHaveTextContent("Status unknown");
    expect(screen.getByTestId("registration-delivery-status")).not.toHaveTextContent("Delivery failed");
  });

  it("accepts the provider's processed event as submitted delivery", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({
      success: true,
      data: statusData({
        actionStatus: "pending",
        deliveryStatus: "processed",
        deliveryJobStatus: "succeeded",
        providerDeliveryEvent: "processed",
      }),
    })));
    renderPage();

    expect(await screen.findByText("Check your email", { exact: true })).toBeInTheDocument();
    expect(screen.getByTestId("registration-delivery-status")).toHaveTextContent("Submitted");
  });
});


describe('RegistrationEmailPage recovery', () => {
  it('treats only the documented missing-session response as normal and stops polling it', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const fetchMock = vi.fn(async (url: string) => url === '/api/user' ? anonymous() : missing());
    vi.stubGlobal('fetch', fetchMock);
    appQueryClient.clear();
    renderPage(appQueryClient);
    await screen.findByText("We couldn't find an active registration session in this browser. If you already have an account, sign in or reset your password. Otherwise, start registration again with the same email address.");
    await act(async () => { await vi.advanceTimersByTimeAsync(90_000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(captureException).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('recognizes completion in another tab and discards the cached anonymous account', async () => {
    let completed = false;
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/user') return json({ success: true, data: { id: 8 } });
      return completed ? missing() : json({ success: true, data: statusData() });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { queryFn: getQueryFn } } });
    client.setQueryData(['/api/user'], { success: true, data: null });
    client.setQueryData(['/api/old-account-data'], { data: ['old account'] });
    renderPage(client);
    await screen.findByText('Check your email', { exact: true });
    completed = true;
    fireEvent(window, new Event('focus'));
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/', { replace: true }));
    expect(client.getQueryData(['/api/old-account-data'])).toBeUndefined();
    expect(client.getQueryData(['/api/user'])).toBeUndefined();
    expect(captureException).not.toHaveBeenCalled();
  });

  it('retries a transient network failure once without reporting a recovered error', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockImplementation(async () => json({ success: true, data: statusData() }));
    vi.stubGlobal('fetch', fetchMock);
    appQueryClient.clear();
    renderPage(appQueryClient);
    await screen.findByText('Check your email', { exact: true }, { timeout: 3000 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(captureException).not.toHaveBeenCalled();
  });

  it('reports an exhausted transport failure once and lets the user retry', async () => {
    let offline = true;
    const fetchMock = vi.fn(async () => {
      if (offline) throw new TypeError('Failed to fetch');
      return json({ success: true, data: statusData() });
    });
    vi.stubGlobal('fetch', fetchMock);
    appQueryClient.clear();
    renderPage(appQueryClient);
    await screen.findByText(/Check your internet connection/, {}, { timeout: 3000 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(captureException).toHaveBeenCalledOnce();
    offline = false;
    fireEvent.click(screen.getByTestId('button-registration-status-retry'));
    await screen.findByText('Check your email', { exact: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('keeps an unexpected 404 actionable instead of hiding a broken endpoint', async () => {
    const fetchMock = vi.fn(async () => new Response('Not found', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    appQueryClient.clear();
    renderPage(appQueryClient);
    await screen.findByText("We couldn't verify your registration", { exact: true });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(captureException).toHaveBeenCalledOnce();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('does not assume successful completion if the follow-up session check fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url === '/api/user'
      ? json({ error: { code: 'SERVER_ERROR', message: 'Unavailable' } }, 503) : missing()));
    renderPage();
    await screen.findByText("We couldn't verify your registration", { exact: true }, { timeout: 3000 });
    expect(navigateMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('button-registration-status-retry')).toBeEnabled();
  });
});
