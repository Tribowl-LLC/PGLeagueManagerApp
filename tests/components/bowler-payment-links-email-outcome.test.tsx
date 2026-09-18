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
vi.mock("@/components/bowler-search-picker", () => ({
  BowlerSearchPicker: ({ onSelect }: { onSelect: (bowler: { id: number }) => void }) => (
    <button type="button" data-testid="invite-picker-result" onClick={() => onSelect({ id: 99 })}>
      Choose invitee
    </button>
  ),
}));

import { BowlerPaymentLinksSection } from "@/components/bowler-payment-links-section";

const linksResponse = {
  success: true,
  data: {
    hasAny: true,
    links: [
      {
        id: 10,
        bowlerAId: 1,
        bowlerBId: 2,
        status: "pending",
        organizationId: 7,
        createdByUserId: 101,
        inviterBowlerId: 1,
        partnerBowlerId: 2,
        partnerName: "Outbound Partner",
      },
      {
        id: 11,
        bowlerAId: 3,
        bowlerBId: 1,
        status: "pending",
        organizationId: 7,
        createdByUserId: 102,
        inviterBowlerId: 3,
        partnerBowlerId: 3,
        partnerName: "Inbound Partner",
      },
      {
        id: 12,
        bowlerAId: 1,
        bowlerBId: 4,
        status: "accepted",
        organizationId: 7,
        createdByUserId: 101,
        inviterBowlerId: 1,
        partnerBowlerId: 4,
        partnerName: "Accepted Partner",
      },
    ],
  },
};

function renderSection() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        queryFn: async () => linksResponse,
      },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <BowlerPaymentLinksSection currentBowlerId={1} alwaysShow />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiRequestMock.mockReset();
  invalidateQueriesMock.mockReset();
  toastMock.mockReset();
});

describe("BowlerPaymentLinksSection email outcomes", () => {
  it("only offers resend for a pending outbound link, while inbound and accepted links keep their own actions", async () => {
    renderSection();

    expect(await screen.findByTestId("button-resend-invite-10")).toBeInTheDocument();
    expect(screen.queryByTestId("button-resend-invite-11")).toBeNull();
    expect(screen.queryByTestId("button-resend-invite-12")).toBeNull();
    expect(screen.getByTestId("button-accept-11")).toBeInTheDocument();
    expect(screen.getByTestId("button-decline-11")).toBeInTheDocument();
  });

  it("reports a created partner invitation without email using the reason and accepts a successful resend envelope", async () => {
    apiRequestMock
      .mockResolvedValueOnce({
        success: true,
        data: { id: 20, emailSent: false, reason: "NO_EMAIL_ON_FILE" },
      })
      .mockResolvedValueOnce({ success: true, data: { emailSent: true } });
    const user = userEvent.setup();
    renderSection();

    await user.click(await screen.findByTestId("invite-picker-result"));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({
      title: "Payment partner invitation created without email",
      description: expect.stringMatching(/no email address is on file/i),
      variant: "destructive",
    })));

    await user.click(screen.getByTestId("button-resend-invite-10"));
    await waitFor(() => expect(apiRequestMock).toHaveBeenLastCalledWith(
      "/api/bowler-links/10/resend-invite",
      "POST",
    ));
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({
      title: "Invitation email submitted",
      description: expect.stringMatching(/submitted again/i),
      variant: "default",
    }));
  });
});
