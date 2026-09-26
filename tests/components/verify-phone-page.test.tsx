import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { apiRequestMock, navigateMock } = vi.hoisted(() => ({
  apiRequestMock: vi.fn(),
  navigateMock: vi.fn(),
}));

vi.mock("@/hooks/use-business-context", () => ({
  useBusinessContext: () => ({ business: null, isLoading: false }),
}));
vi.mock("wouter", async (importOriginal) => ({
  ...await importOriginal<typeof import("wouter")>(),
  useLocation: () => ["/verify-phone", navigateMock],
}));
vi.mock("@/lib/queryClient", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/queryClient")>(),
  apiRequest: apiRequestMock,
}));

import VerifyPhonePage from "@/pages/verify-phone-page";

const originalFetch = global.fetch;

function statusResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function renderPage() {
  return render(<VerifyPhonePage />);
}

beforeEach(() => {
  apiRequestMock.mockReset();
  navigateMock.mockReset();
  vi.stubGlobal("fetch", vi.fn(async () => statusResponse({
    success: true,
    data: {
      phase: "verify_phone",
      status: "pending",
      phoneMasked: "(555) 010-2026",
      delivery: "sms",
      resendAvailableAt: "2099-01-01T00:00:00.000Z",
    },
  })));
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.unstubAllGlobals();
});

describe("VerifyPhonePage public flow", () => {
  it("renders the SMS gallery state and verifies a six-digit code", async () => {
    apiRequestMock.mockResolvedValue({ success: true, data: { phase: "set_password" } });
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText("Check your texts.", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("(555) 010-2026")).toBeInTheDocument();
    expect(screen.getByLabelText("Registration step 2 of 3")).toBeInTheDocument();
    const codeInput = screen.getByLabelText("Six-digit verification code");
    await user.type(codeInput, "123456");

    await waitFor(() => expect(apiRequestMock).toHaveBeenCalledWith(
      "/api/auth/registration/verify",
      "POST",
      { code: "123456" },
    ));
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith("/set-password?registration=sms"));
  });

  it("returns an unavailable registration session to the public registration route", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => statusResponse({ error: { code: "AUTH_REQUIRED" } }, 401)));
    renderPage();

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith("/register"));
  });
});
