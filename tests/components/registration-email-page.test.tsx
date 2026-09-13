import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "@/lib/api-error";

const { apiRequestMock } = vi.hoisted(() => ({ apiRequestMock: vi.fn() }));
vi.mock("@/lib/queryClient", async () => {
  const actual = await vi.importActual<typeof import("@/lib/queryClient")>("@/lib/queryClient");
  return { ...actual, apiRequest: apiRequestMock };
});

import RegistrationEmailPage from "@/pages/registration-email-page";

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
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
});

describe("RegistrationEmailPage delivery states", () => {
  it("uses neutral recovery actions when the server has no registration capability", async () => {
    apiRequestMock.mockRejectedValue(new ApiError({
      message: "Registration status is unavailable.",
      status: 404,
      code: "NOT_FOUND",
    }));
    renderPage();

    expect(await screen.findByText("Continue registration", { exact: true })).toBeInTheDocument();
    expect(screen.getByTestId("link-registration-continue")).toHaveTextContent("Continue sign-up");
    expect(screen.getByTestId("link-registration-sign-in")).toHaveTextContent("Sign in");
    expect(screen.getByTestId("link-registration-forgot-password")).toHaveTextContent("Forgot password?");
    expect(screen.queryByText(/session is no longer available/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/different email/i)).not.toBeInTheDocument();
  });

  it("shows a confirmed delivery failure while the pending account remains actionable", async () => {
    apiRequestMock.mockResolvedValue({ success: true, data: statusData() });
    renderPage();

    expect(await screen.findByText("Check your email", { exact: true })).toBeInTheDocument();
    expect(screen.getByTestId("registration-delivery-status")).toHaveTextContent("Delivery failed");
    expect(screen.queryByText("Registration status unavailable")).not.toBeInTheDocument();
    expect(screen.getByTestId("button-registration-resend")).toBeEnabled();
  });

  it("does not turn an uncertain retry into a confirmed bad-address failure", async () => {
    apiRequestMock.mockResolvedValue({
      success: true,
      data: statusData({
        actionStatus: "pending",
        deliveryStatus: "unknown",
        deliveryJobStatus: "retry_scheduled",
        deliveryLastErrorCode: "provider_error",
      }),
    });
    renderPage();

    expect(await screen.findByText("Check your email", { exact: true })).toBeInTheDocument();
    expect(screen.getByTestId("registration-delivery-status")).toHaveTextContent("Status unknown");
    expect(screen.getByTestId("registration-delivery-status")).not.toHaveTextContent("Delivery failed");
  });

  it("accepts the provider's processed event as submitted delivery", async () => {
    apiRequestMock.mockResolvedValue({
      success: true,
      data: statusData({
        actionStatus: "pending",
        deliveryStatus: "processed",
        deliveryJobStatus: "succeeded",
        providerDeliveryEvent: "processed",
      }),
    });
    renderPage();

    expect(await screen.findByText("Check your email", { exact: true })).toBeInTheDocument();
    expect(screen.getByTestId("registration-delivery-status")).toHaveTextContent("Submitted");
  });
});
