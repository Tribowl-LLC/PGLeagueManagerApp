import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";

vi.mock("@/components/layout", () => ({
  Layout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import PaymentDisputesPage from "@/pages/payment-disputes-page";

const originalFetch = global.fetch;
const disputeId = "11111111-1111-4111-8111-111111111111";

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function dispute(overrides: Record<string, unknown> = {}) {
  return {
    id: disputeId,
    locationId: 4,
    paymentOperationId: "22222222-2222-4222-8222-222222222222",
    amountMinor: 2500,
    currency: "USD",
    reason: "NO_KNOWLEDGE",
    state: "EVIDENCE_REQUIRED",
    responseDueAt: "2034-03-11T12:00:00.000Z",
    cardBrand: "VISA",
    providerCreatedAt: "2034-03-01T00:00:00.000Z",
    providerReportedAt: "2034-03-01T00:00:00.000Z",
    providerUpdatedAt: "2034-03-10T12:00:00.000Z",
    providerVersion: 3,
    acknowledgementId: null,
    acknowledgedProviderVersion: null,
    acknowledgedByUserId: null,
    acknowledgedByRole: null,
    acknowledgedAt: null,
    createdAt: "2034-03-10T12:00:00.000Z",
    updatedAt: "2034-03-10T12:00:00.000Z",
    ...overrides,
  };
}

function renderPage() {
  return render(
    <QueryClientProvider client={queryClient}>
      <PaymentDisputesPage />
    </QueryClientProvider>,
  );
}

describe("<PaymentDisputesPage />", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2034-03-10T12:00:00.000Z"));
    queryClient.clear();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    queryClient.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("shows nonterminal provider deadlines and immutable sanitized history", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/user") {
        return response({ success: true, data: { id: 7, role: "org_admin", organizationId: 11 } });
      }
      if (url === "/api/payment-disputes?limit=100") {
        return response({ success: true, data: { items: [dispute()], nextCursor: null } });
      }
      if (url === "/api/payment-disputes/unacknowledged-count") {
        return response({ success: true, data: { count: 1 } });
      }
      if (url.includes("/api/payment-disputes/notifications?")) {
        return response({ success: true, data: { items: [{
          id: "33333333-3333-4333-8333-333333333333",
          kind: "DISPUTE_STATE_UPDATED",
          disputeState: "EVIDENCE_REQUIRED",
          providerVersion: 3,
          acknowledgementId: null,
          acknowledgedByUserId: null,
          acknowledgedByRole: null,
          acknowledgedAt: null,
          createdAt: "2034-03-10T12:00:00.000Z",
        }], nextCursor: null } });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPage();
    expect(await screen.findByText("Provider deadline approaching")).toBeInTheDocument();
    expect(screen.getByText("1 unacknowledged")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /history/i }));
    expect(await screen.findByRole("heading", { name: "Dispute state history" })).toBeInTheDocument();
    expect(screen.getByTestId("dispute-history-version-3")).toHaveTextContent("Not acknowledged");
    expect(screen.getByText(/immutable, sanitized Square webhook records/i)).toBeInTheDocument();
    expect(screen.queryByText(/encryptedPayload|providerMerchantId|webhook body/i)).not.toBeInTheDocument();
  });

  it("acknowledges the exact version without any provider request", async () => {
    let acknowledged = false;
    const observedUrls: string[] = [];
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      observedUrls.push(url);
      if (url === "/api/user") {
        return response({ success: true, data: { id: 7, role: "org_admin", organizationId: 11 } });
      }
      if (url === "/api/csrf-token") {
        return response({ success: true, data: { token: "deterministic-csrf-token" } });
      }
      if (url === "/api/payment-disputes?limit=100") {
        return response({ success: true, data: { items: [dispute(acknowledged ? {
          acknowledgementId: "44444444-4444-4444-8444-444444444444",
          acknowledgedProviderVersion: 3,
          acknowledgedByUserId: 7,
          acknowledgedByRole: "org_admin",
          acknowledgedAt: "2034-03-10T12:05:00.000Z",
        } : {})], nextCursor: null } });
      }
      if (url === "/api/payment-disputes/unacknowledged-count") {
        return response({ success: true, data: { count: acknowledged ? 0 : 1 } });
      }
      if (url === `/api/payment-disputes/${disputeId}/acknowledgements`) {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({ providerVersion: 3 });
        acknowledged = true;
        return response({ success: true, data: { providerVersion: 3, created: true } });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPage();
    await user.click(await screen.findByTestId(`button-acknowledge-dispute-${disputeId}`));
    await waitFor(() => expect(screen.getByText(/^Acknowledged$/)).toBeInTheDocument());
    expect(screen.getByText("0 unacknowledged")).toBeInTheDocument();
    expect(observedUrls.some((url) => url.includes("squareup") || url.includes("/v2/disputes"))).toBe(false);
    expect(screen.queryByText(/resolved|handled/i)).not.toBeInTheDocument();
  });

  it("does not warn on a terminal state's retained provider deadline", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/user") {
        return response({ success: true, data: { id: 7, role: "org_admin", organizationId: 11 } });
      }
      if (url === "/api/payment-disputes?limit=100") {
        return response({ success: true, data: { items: [dispute({
          state: "WON",
          responseDueAt: "2034-03-01T00:00:00.000Z",
        })], nextCursor: null } });
      }
      if (url === "/api/payment-disputes/unacknowledged-count") {
        return response({ success: true, data: { count: 1 } });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    renderPage();
    expect(await screen.findByText("Won")).toBeInTheDocument();
    expect(screen.queryByText(/deadline passed|deadline approaching/i)).not.toBeInTheDocument();
  });

  it("requires a system administrator to select one tenant explicitly", async () => {
    const observedUrls: string[] = [];
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      observedUrls.push(url);
      if (url === "/api/user") {
        return response({ success: true, data: { id: 8, role: "system_admin", organizationId: null } });
      }
      if (url === "/api/organizations") {
        return response({ success: true, data: [{ id: 22, name: "Selected Fixture" }] });
      }
      if (url === "/api/payment-disputes?limit=100&organizationId=22") {
        return response({ success: true, data: { items: [], nextCursor: null } });
      }
      if (url === "/api/payment-disputes/unacknowledged-count?organizationId=22") {
        return response({ success: true, data: { count: 0 } });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPage();
    expect(await screen.findByText("Select an organization to view its disputes.")).toBeInTheDocument();
    expect(observedUrls.some((url) => url.startsWith("/api/payment-disputes?"))).toBe(false);
    await user.selectOptions(screen.getByLabelText("Select one organization"), "22");
    expect(await screen.findByText("No payment disputes recorded")).toBeInTheDocument();
    expect(observedUrls).toContain("/api/payment-disputes?limit=100&organizationId=22");
    expect(observedUrls).toContain("/api/payment-disputes/unacknowledged-count?organizationId=22");
  });
});
