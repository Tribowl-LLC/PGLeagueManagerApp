import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));

import SignUpPage from "@/pages/sign-up-page";

type FetchHandler = (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>;

const originalFetch = global.fetch;
let registerHandler: FetchHandler;

function installFetchMock() {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/organizations/public-leagues")) {
      return new Response(JSON.stringify({ success: true, data: [{ id: 7, name: "Monday League" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/api/auth/register")) return registerHandler(input, init);
    return new Response(JSON.stringify({ success: true, data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

function renderPage() {
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
  await user.type(screen.getByLabelText(/full name/i), "Jane Bowler");
  await user.type(screen.getByLabelText(/email address/i), "jane@example.com");
  await user.type(screen.getByLabelText(/phone number/i), "5551234567");
  await user.click(await screen.findByRole("combobox", { name: /league/i }));
  await user.click(screen.getByRole("option", { name: "Monday League" }));
  await user.type(screen.getByLabelText(/^password$/i), "Strong!9x");
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
  installFetchMock();
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe("SignUpPage API outcomes", () => {
  it("handles duplicate email without reporting an API issue", async () => {
    registerHandler = () => response(
      { success: false, error: { code: "DUPLICATE_EMAIL", message: "Email already registered" } },
      400,
    );
    const user = userEvent.setup();
    renderPage();

    await fillAndSubmit(user);

    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Account Already Exists" }));
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
