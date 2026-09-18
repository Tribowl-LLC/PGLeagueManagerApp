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

import { AddUserDialog } from "@/components/add-user-dialog";

function renderDialog() {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AddUserDialog open onClose={vi.fn()} orgLocations={[]} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiRequestMock.mockReset();
  toastMock.mockReset();
});

describe("AddUserDialog invitation email outcome", () => {
  it.each([
    ["false", { success: true, data: { emailSent: false } }],
    ["missing", { success: true, data: {} }],
  ])("does not report an invitation as sent when the envelope outcome is %s", async (_label, response) => {
    apiRequestMock.mockResolvedValueOnce(response);
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText("First Name"), "Taylor");
    await user.type(screen.getByLabelText("Last Name"), "Bowler");
    await user.type(screen.getByLabelText("Email Address"), "taylor@example.com");
    await user.click(screen.getByRole("button", { name: "Create User" }));

    await waitFor(() => expect(apiRequestMock).toHaveBeenCalledWith(
      "/api/org-admin/users/create",
      "POST",
      expect.objectContaining({ email: "taylor@example.com" }),
    ));
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({
      title: "User created",
      description: "User created, but the invitation email was not sent. You can resend it from the user list.",
      variant: "destructive",
    }));
    expect(toastMock).not.toHaveBeenCalledWith(expect.objectContaining({
      description: expect.stringMatching(/email was submitted/i),
    }));
  });

  it("reports an envelope emailSent=true as submitted", async () => {
    apiRequestMock.mockResolvedValueOnce({ success: true, data: { emailSent: true } });
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText("First Name"), "Taylor");
    await user.type(screen.getByLabelText("Last Name"), "Bowler");
    await user.type(screen.getByLabelText("Email Address"), "taylor@example.com");
    await user.click(screen.getByRole("button", { name: "Create User" }));

    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({
      title: "User created",
      description: expect.stringMatching(/invitation email was submitted/i),
      variant: "default",
    })));
  });
});
