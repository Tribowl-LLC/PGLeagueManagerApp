import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { apiRequestMock, toastMock } = vi.hoisted(() => ({
  apiRequestMock: vi.fn(),
  toastMock: vi.fn(),
}));

vi.mock("@/lib/queryClient", async () => {
  const actual = await vi.importActual<typeof import("../../client/src/lib/queryClient")>(
    "../../client/src/lib/queryClient",
  );
  return { ...actual, apiRequest: apiRequestMock };
});
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastMock }),
}));

import { ProfileInfoCard, type CurrentUserWithSyncStatus } from "@/components/profile-info-card";

const USER: CurrentUserWithSyncStatus = {
  id: 1,
  email: "old@example.com",
  password: "unused",
  credentialGeneration: 0,
  bowlerId: 42,
  name: "Profile Tester",
  phone: null,
  avatar: null,
  role: "user",
  organizationId: 7,
  locationId: null,
  preferredLanguage: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  mustChangePassword: false,
  failedPasswordChangeAttempts: 0,
  passwordChangeLockedUntil: null,
  paymentSyncStatus: null,
};

function renderCard() {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ProfileInfoCard currentUser={USER} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiRequestMock.mockReset();
  toastMock.mockReset();
});

describe("ProfileInfoCard email change outcomes", () => {
  it.each([
    ["not_sent", "The confirmation email was not sent."],
    ["unknown", "We could not confirm the confirmation email request."],
  ] as const)("keeps the pending change and offers a same-address retry when confirmation is %s", async (confirmation, expectedCopy) => {
    apiRequestMock.mockResolvedValueOnce({
      success: true,
      data: {
        paymentSyncStatus: "not_applicable",
        emailChangeRequested: true,
        emailChangeDelivery: { confirmation, notification: "not_sent" },
      },
    });
    const user = userEvent.setup();
    renderCard();

    await user.click(screen.getByRole("button", { name: /edit profile/i }));
    const email = screen.getByLabelText("Email");
    await user.clear(email);
    await user.type(email, "new@example.com");
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(screen.getByTestId("email-change-pending")).toBeInTheDocument());
    expect(screen.getByText(new RegExp(expectedCopy.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))).toBeInTheDocument();
    expect(screen.getByText(/sign-in email remains old@example.com/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /edit profile/i }));
    await waitFor(() => expect(screen.getByLabelText("Email")).toHaveValue("old@example.com"));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByTestId("button-retry-email-change"));
    expect(screen.getByLabelText("Email")).toHaveValue("new@example.com");
  });

  it("does not claim a request when the email change outcome is missing and leaves the form open", async () => {
    apiRequestMock.mockResolvedValueOnce({ success: true, data: {} });
    const user = userEvent.setup();
    renderCard();

    await user.click(screen.getByRole("button", { name: /edit profile/i }));
    const email = screen.getByLabelText("Email");
    await user.clear(email);
    await user.type(email, "new@example.com");
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({
      title: "Email change was not submitted",
      variant: "destructive",
    })));
    expect(screen.getByLabelText("Email")).toHaveValue("new@example.com");
    expect(toastMock).not.toHaveBeenCalledWith(expect.objectContaining({ title: /email sent/i }));
  });

  it("does not reissue an accepted pending email change during a later name-only edit", async () => {
    apiRequestMock
      .mockResolvedValueOnce({
        success: true,
        data: {
          emailChangeRequested: true,
          emailChangeDelivery: { confirmation: "accepted", notification: "accepted" },
        },
      })
      .mockResolvedValueOnce({ success: true, data: {} });
    const user = userEvent.setup();
    renderCard();

    await user.click(screen.getByRole("button", { name: /edit profile/i }));
    const email = screen.getByLabelText("Email");
    await user.clear(email);
    await user.type(email, "new@example.com");
    await user.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => expect(screen.getByTestId("email-change-pending")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /edit profile/i }));
    await waitFor(() => expect(screen.getByLabelText("Email")).toHaveValue("old@example.com"));
    const name = screen.getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Updated Tester");
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(apiRequestMock).toHaveBeenCalledTimes(2));
    expect(apiRequestMock.mock.calls[1][2]).toEqual(expect.objectContaining({
      name: "Updated Tester",
      email: "old@example.com",
    }));
    expect(apiRequestMock.mock.calls[1][2]).not.toEqual(expect.objectContaining({
      email: "new@example.com",
    }));
    expect(screen.getByTestId("email-change-pending")).toBeInTheDocument();
  });
});
