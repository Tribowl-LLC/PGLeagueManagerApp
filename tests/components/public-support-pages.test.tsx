import type { ReactNode } from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Router } from "wouter";

const { toastMock } = vi.hoisted(() => ({ toastMock: vi.fn() }));

vi.mock("@/components/public-page-layout", () => ({
  PublicPageLayout: ({ children }: { children: ReactNode }) => <div data-testid="public-page-layout">{children}</div>,
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastMock }),
}));

if (typeof globalThis.ResizeObserver === "undefined") {
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = NoopResizeObserver;
}

import PrivacyPolicyPage from "@/pages/privacy-policy-page";
import DeleteAccountPage from "@/pages/delete-account-page";
import ProfileClaimReportPage from "@/pages/profile-claim-report-page";

const originalFetch = global.fetch;

function renderInRouter(children: ReactNode, search = "") {
  return render(
    <Router
      hook={() => ["/test", vi.fn()]}
      searchHook={() => search}
    >
      {children}
    </Router>,
  );
}

beforeEach(() => {
  toastMock.mockReset();
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe("public support pages", () => {
  it("keeps the privacy policy legal copy and production back action", async () => {
    Object.defineProperty(window.history, "length", { configurable: true, value: 2 });
    const backSpy = vi.spyOn(window.history, "back").mockImplementation(() => {});
    renderInRouter(<PrivacyPolicyPage />);

    expect(screen.getByRole("heading", { name: "Privacy Policy" })).toBeInTheDocument();
    expect(screen.getByText(/LeagueVault \("we," "our," or "us"\)/)).toBeInTheDocument();
    expect(screen.getByText("support@leaguevault.app")).toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole("button", { name: /back/i }));
    expect(backSpy).toHaveBeenCalledOnce();
    backSpy.mockRestore();
  });

  it("submits the deletion request with the notification preference", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });
    global.fetch = fetchMock;
    renderInRouter(<DeleteAccountPage />);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Email address"), "bowler@example.com");
    await user.click(screen.getByRole("checkbox", { name: /email me a confirmation/i }));
    await user.type(screen.getByLabelText(/reason/i), "I no longer use this account");
    await user.click(screen.getByRole("button", { name: /submit deletion request/i }));

    expect(fetchMock).toHaveBeenCalledOnce();
    const request = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(String(request?.body))).toEqual({
      email: "bowler@example.com",
      reason: "I no longer use this account",
      notifyOnCompletion: false,
    });
    expect(await screen.findByRole("heading", { name: /request received/i })).toBeInTheDocument();
    expect(screen.getByText(/we will not request a confirmation email/i)).toBeInTheDocument();
  });

  it("loads a profile report and sends the server-issued CSRF proof", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: { profileName: "Alex Morgan", csrfToken: "csrf-proof" },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }));
    global.fetch = fetchMock;
    renderInRouter(<ProfileClaimReportPage />, "token=report-token");

    const user = userEvent.setup();
    expect(await screen.findByText("An account was connected to Alex Morgan.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /this wasn.t me/i }));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/profile-claims/report?token=report-token");
    const [postUrl, postInit] = fetchMock.mock.calls[1] ?? [];
    expect(postUrl).toBe("/api/profile-claims/report");
    expect(postInit).toMatchObject({
      method: "POST",
      credentials: "include",
      headers: expect.objectContaining({
        "x-claim-report-csrf": "csrf-proof",
      }),
    });
    expect(JSON.parse(String((postInit as RequestInit).body))).toEqual({
      token: "report-token",
      confirm: true,
    });
    expect(await screen.findByText("Report received")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/report received/i);
  });

  it("names the pending report action", async () => {
    const pendingPost = new Promise<Response>(() => {});
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: { profileName: "Alex Morgan", csrfToken: "csrf-proof" },
      }), { status: 200 }))
      .mockReturnValueOnce(pendingPost);
    global.fetch = fetchMock;
    renderInRouter(<ProfileClaimReportPage />, "token=report-token");

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /this wasn.t me/i }));
    expect(screen.getByRole("button", { name: /reporting/i })).toBeDisabled();
  });

  it("announces report errors", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: false,
        error: { message: "This report link is invalid or expired." },
      }), { status: 410 }));
    global.fetch = fetchMock;
    renderInRouter(<ProfileClaimReportPage />, "token=expired-token");
    expect(await screen.findByRole("alert")).toHaveTextContent(/unable to continue/i);
  });
});
