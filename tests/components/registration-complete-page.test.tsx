import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getQueryFn } from "@/lib/queryClient";

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("wouter", async () => {
  const actual = await vi.importActual<typeof import("wouter")>("wouter");
  return { ...actual, useLocation: () => ["/registration-complete", navigate] };
});

import RegistrationCompletePage from "@/pages/registration-complete-page";
import { ProtectedRoute } from "@/components/protected-route";

const originalFetch = global.fetch;
let userResponses: unknown[];

function userResponse(bowlerId: number | null) {
  return {
    success: true,
    data: {
      id: 7,
      email: "pending@example.com",
      name: "Pending Bowler",
      phone: null,
      avatar: null,
      role: "user",
      organizationId: 1,
      locationId: null,
      bowlerId,
      preferredLanguage: null,
      failedPasswordChangeAttempts: 0,
      passwordChangeLockedUntil: null,
      mustChangePassword: false,
      password: "never returned",
      createdAt: "2026-01-01T00:00:00Z",
    },
  };
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, queryFn: getQueryFn }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RegistrationCompletePage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  navigate.mockClear();
  userResponses = [userResponse(null)];
  global.fetch = async () => new Response(JSON.stringify(userResponses.shift()), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe("RegistrationCompletePage", () => {
  it("shows the waiting copy and routes to the dashboard after a fresh linked status", async () => {
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText("Registration in progress")).toBeInTheDocument();
    expect(screen.getByText(/your sign-in account has been created/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /view profile/i })).toHaveAttribute("href", "/profile");
    expect(screen.getByRole("button", { name: /sign out/i })).toBeInTheDocument();

    userResponses.push(userResponse(42));
    await user.click(screen.getByTestId("button-check-registration-status"));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/bowler-dashboard"));
  });

  it("keeps a status network error actionable instead of treating it as unmatched", async () => {
    global.fetch = async () => new Response("offline", { status: 503 });
    renderPage();

    expect(await screen.findByText(/couldn’t check registration status/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("does not route from linked cached data when the fresh status read fails", async () => {
    global.fetch = async () => new Response("offline", { status: 503 });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, queryFn: getQueryFn }, mutations: { retry: false } },
    });
    queryClient.setQueryData(["/api/user"], userResponse(42));

    render(
      <QueryClientProvider client={queryClient}>
        <RegistrationCompletePage />
      </QueryClientProvider>,
    );

    expect(await screen.findByText(/couldn’t check registration status/i)).toBeInTheDocument();
    expect(screen.getByTestId("button-check-registration-status")).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("stays mounted with the retry UI when the protected status read fails transiently", async () => {
    let requestCount = 0;
    global.fetch = async () => {
      requestCount += 1;
      return new Response("offline", { status: 503 });
    };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, queryFn: getQueryFn }, mutations: { retry: false } },
    });
    queryClient.setQueryData(["/api/user"], userResponse(null));

    render(
      <QueryClientProvider client={queryClient}>
        <ProtectedRoute requirement="auth">
          <RegistrationCompletePage />
        </ProtectedRoute>
      </QueryClientProvider>,
    );

    expect(await screen.findByText(/couldn’t check registration status/i)).toBeInTheDocument();
    expect(screen.getByTestId("button-check-registration-status")).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
    // Both observers share one real QueryClient request and the protected
    // wrapper does not unmount/remount the pending page on isFetching.
    expect(requestCount).toBe(1);
  });

  it("shows a retry state for a cached user when the guard cannot verify the session", async () => {
    global.fetch = async () => new Response("temporary outage", { status: 503 });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, queryFn: getQueryFn }, mutations: { retry: false } },
    });
    queryClient.setQueryData(["/api/user"], userResponse(42), { updatedAt: 0 });

    render(
      <QueryClientProvider client={queryClient}>
        <ProtectedRoute requirement="auth"><div data-testid="protected-content">Protected content</div></ProtectedRoute>
      </QueryClientProvider>,
    );

    expect(await screen.findByRole("button", { name: /retry/i })).toBeInTheDocument();
    expect(screen.queryByTestId("protected-content")).not.toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });
});
