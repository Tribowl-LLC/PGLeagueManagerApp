import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { apiRequestMock, invalidateQueriesMock, toastMock } = vi.hoisted(() => ({
  apiRequestMock: vi.fn(),
  invalidateQueriesMock: vi.fn(),
  toastMock: vi.fn(),
}));

vi.mock("@/lib/queryClient", () => ({
  apiRequest: apiRequestMock,
  queryClient: { invalidateQueries: invalidateQueriesMock },
}));
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastMock }),
}));

import { InviteResultCard } from "@/pages/league-view-page/invite-result-card";

function renderCard() {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <InviteResultCard
        inviteResult={{
          sent: 3,
          created: 3,
          emailAccepted: 2,
          deliveryFailed: 1,
          alreadyRegistered: 4,
          noEmail: 2,
          failedInvitations: [{ userId: 41, name: "Casey Bowler" }],
        }}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiRequestMock.mockReset();
  invalidateQueriesMock.mockReset();
  toastMock.mockReset();
});

describe("InviteResultCard email outcomes", () => {
  it("shows invitation and batch email counts separately and offers recovery for failed records", () => {
    renderCard();

    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("Batch email submitted")).toBeInTheDocument();
    expect(screen.getByText("Batch email not sent")).toBeInTheDocument();
    expect(screen.getByText("Casey Bowler")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /resend email/i })).toBeInTheDocument();
  });

  it("treats only an envelope emailSent=true as accepted for a recovery resend", async () => {
    apiRequestMock.mockResolvedValueOnce({ success: true, data: { emailSent: true } });
    const user = userEvent.setup();
    renderCard();

    await user.click(screen.getByRole("button", { name: /resend email/i }));

    await waitFor(() => {
      expect(apiRequestMock).toHaveBeenCalledWith(
        "/api/org-admin/users/41/resend-invite",
        "POST",
      );
      expect(screen.getByText("Email submitted")).toBeInTheDocument();
    });
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({
      title: "Invitation email submitted",
    }));
  });

  it.each([
    ["false", { success: true, data: { emailSent: false } }],
    ["missing", { success: true, data: {} }],
  ])("keeps recovery available when the envelope outcome is %s", async (_label, response) => {
    apiRequestMock.mockResolvedValueOnce(response);
    const user = userEvent.setup();
    renderCard();

    await user.click(screen.getByRole("button", { name: /resend email/i }));

    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({
        title: "Invitation email not sent",
        variant: "destructive",
      }));
    });
    expect(screen.getByRole("button", { name: /resend email/i })).toBeInTheDocument();
  });

  it("keeps the row retryable and labels a provider error as unknown", async () => {
    apiRequestMock.mockRejectedValueOnce(new Error("temporary provider error"));
    const user = userEvent.setup();
    renderCard();

    await user.click(screen.getByRole("button", { name: /resend email/i }));

    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({
        title: "Invitation email status unknown",
      }));
    });
    expect(screen.getByRole("button", { name: /check or retry email/i })).toBeInTheDocument();
  });
});
