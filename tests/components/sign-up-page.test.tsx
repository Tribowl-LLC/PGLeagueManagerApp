import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/hooks/use-business-context", () => ({
  useBusinessContext: () => ({ business: null, isLoading: false }),
}));

import SignUpPage from "@/pages/sign-up-page";

type FetchHandler = (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>;

const originalFetch = global.fetch;
let registerHandler: FetchHandler;
let availabilityHandler: FetchHandler;

function installFetchMock(availability: FetchHandler, register: FetchHandler) {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/auth/registration/availability")) return availability(input, init);
    if (url.includes("/api/auth/register")) return register(input, init);
    return new Response(JSON.stringify({ success: true, data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

function renderPage() {
  installFetchMock(availabilityHandler, registerHandler);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <SignUpPage />
    </QueryClientProvider>,
  );
}

async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText(/full name/i), "Jane Bowler");
  await user.type(await screen.findByLabelText(/email address/i), "jane@example.com");
  await user.type(await screen.findByLabelText(/phone number/i), "5551234567");
  await waitFor(() => expect(screen.getByTestId("button-signup-submit")).toBeEnabled());
  await user.click(screen.getByRole("button", { name: /create account/i }));
}

function response(body: unknown, status: number, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

beforeEach(() => {
  toast.mockClear();
  registerHandler = () => response({ success: false, error: { message: "failed" } }, 500);
  availabilityHandler = () => response({ success: true, data: { available: true } }, 200);
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe("SignUpPage API outcomes", () => {
  it("keeps submit disabled while availability is loading", async () => {
    let resolveAvailability: ((value: Response) => void) | undefined;
    availabilityHandler = () => new Promise<Response>((resolve) => {
      resolveAvailability = resolve;
    });
    renderPage();

    expect(await screen.findByTestId("alert-signup-availability-loading")).toBeInTheDocument();
    expect(screen.queryByTestId("button-signup-submit")).not.toBeInTheDocument();

    resolveAvailability?.(response({ success: true, data: { available: true } }, 200));
    await waitFor(() => expect(screen.getByTestId("button-signup-submit")).toBeEnabled());
  });

  it("keeps submit disabled and gives generic tenant-link guidance when unavailable", async () => {
    availabilityHandler = vi.fn(() => response({ success: true, data: { available: false } }, 200));
    renderPage();

    expect(await screen.findByTestId("alert-signup-availability-unavailable")).toHaveTextContent(/registration link provided by your league administrator/i);
    expect(screen.queryByTestId("button-signup-submit")).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(availabilityHandler).toHaveBeenCalledTimes(2));
  });

  it("handles duplicate email without reporting an API issue", async () => {
    registerHandler = () => response(
      { success: true, data: { status: "pending", email: "j***@example.com" } },
      202,
    );
    const user = userEvent.setup();
    renderPage();

    await fillAndSubmit(user);

    expect(global.fetch).toHaveBeenCalledWith("/api/auth/register", expect.objectContaining({
      body: JSON.stringify({ name: "Jane Bowler", email: "jane@example.com", phone: "5551234567" }),
    }));
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Registration request received",
      description: expect.stringMatching(/six-digit verification code|password-reset instructions/i),
    }));
  });

  it("uses Retry-After to show a disabled sign-up cooldown", async () => {
    registerHandler = () => response(
      { success: false, error: { code: "RATE_LIMITED", message: "Too many requests" } },
      429,
      { "retry-after": "60" },
    );
    const user = userEvent.setup();
    renderPage();

    await fillAndSubmit(user);

    expect(await screen.findByTestId("alert-signup-throttled")).toHaveTextContent(/too many sign-up attempts/i);
    expect(screen.getByTestId("text-signup-retry-in")).toHaveTextContent("1 minute");
    expect(screen.getByRole("button", { name: /try again in 1 minute/i })).toBeDisabled();
  });

  it("rejects a successful response without the validated bowlerId envelope", async () => {
    registerHandler = () => response({ success: true, data: {} }, 201);
    const user = userEvent.setup();
    renderPage();

    await fillAndSubmit(user);

    expect(await screen.findByText("The sign-up response was invalid. Please try again.")).toBeInTheDocument();
  });
});
