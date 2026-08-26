import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bowler, League } from "@shared/schema";

const { csrfFetchMock, tokenizeCardMock, invalidateQueriesMock, toastMock } = vi.hoisted(() => ({
  csrfFetchMock: vi.fn(),
  tokenizeCardMock: vi.fn(),
  invalidateQueriesMock: vi.fn(),
  toastMock: vi.fn(),
}));

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return { ...actual, useCallback: <T>(callback: T): T => callback };
});
vi.mock("wouter", () => ({ useLocation: () => ["/test", vi.fn()] as const }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: toastMock }) }));
vi.mock("@/lib/queryClient", () => ({
  csrfFetch: csrfFetchMock,
  queryClient: { invalidateQueries: invalidateQueriesMock },
}));
vi.mock("@/lib/square", () => ({ tokenizeCard: tokenizeCardMock }));
vi.mock("@/lib/provider-not-configured", () => ({
  isProviderNotConfiguredError: () => false,
  providerNotConfiguredToast: () => ({ title: "Provider unavailable", description: "", variant: "destructive" }),
  makeApiError: (_body: unknown, status: number, message: string) => Object.assign(new Error(message), { status }),
}));

import { useBowlerPaymentSubmit } from "@/hooks/use-bowler-payment-submit";

const obligationId = "11111111-1111-4111-8111-111111111111";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function league(): League {
  return { id: 11, locationId: 99, paymentMode: "weekly" } as unknown as League;
}

function bowler(): Bowler {
  return { id: 42 } as unknown as Bowler;
}

function submit(overrides: Partial<Parameters<typeof useBowlerPaymentSubmit>[0]> = {}) {
  return useBowlerPaymentSubmit({
    league: league(),
    bowler: bowler(),
    weeklyFee: 2_000,
    card: null,
    cardMode: "saved",
    selectedSavedCardId: "card-1",
    selectedSchedule: "weekly",
    storeCard: false,
    occurrenceAllocations: [{ obligationId, amountMinor: 2_000 }],
    occurrenceReadiness: "ready",
    financials: { fullSeasonAmount: 60_000, remainingBalance: 2_000, amountPastDue: 2_000 },
    calculateTotalAmount: () => 2_000,
    setIsSubmitting: vi.fn(),
    setShowPaymentSetup: vi.fn(),
    ...overrides,
  });
}

beforeEach(() => {
  csrfFetchMock.mockReset();
  tokenizeCardMock.mockReset();
  invalidateQueriesMock.mockReset();
  toastMock.mockReset();
});

describe("useBowlerPaymentSubmit", () => {
  it("quotes and charges the selected canonical obligations with a saved card", async () => {
    csrfFetchMock
      .mockResolvedValueOnce(response({ data: { fingerprint: "lvrosterquote:v1:abc", payerBowlerId: 42 } }))
      .mockResolvedValueOnce(response({ data: { contractVersion: "interactive-obligation-charge/2", operationId: "op-1", status: "succeeded" } }, 201));

    await submit()();

    expect(csrfFetchMock).toHaveBeenCalledTimes(2);
    expect(csrfFetchMock.mock.calls[0]?.[0]).toBe("/api/financials/leagues/11/interactive-obligation-quote/2");
    expect(JSON.parse(csrfFetchMock.mock.calls[0]?.[1].body)).toMatchObject({
      obligationIds: [obligationId],
      allocations: [{ obligationId, amountMinor: 2_000 }],
      payerBowlerId: 42,
    });
    expect(csrfFetchMock.mock.calls[1]?.[0]).toBe("/api/financials/leagues/11/interactive-obligation-charge/2");
    expect(JSON.parse(csrfFetchMock.mock.calls[1]?.[1].body)).toMatchObject({
      obligationIds: [obligationId],
      sourceId: "card-1",
      sourceKind: "saved_card",
      requestFingerprint: "lvrosterquote:v1:abc",
    });
    expect(csrfFetchMock.mock.calls[1]?.[1].headers).toMatchObject({ "Content-Type": "application/json" });
    expect(toastMock).toHaveBeenCalledWith({ title: "Payment submitted", description: "Your exact obligations were paid." });
  });

  it("tokenizes and charges a new card through the same canonical endpoint", async () => {
    tokenizeCardMock.mockResolvedValue("card-token");
    csrfFetchMock
      .mockResolvedValueOnce(response({ data: { fingerprint: "lvrosterquote:v1:def", payerBowlerId: 42 } }))
      .mockResolvedValueOnce(response({ data: { contractVersion: "interactive-obligation-charge/2", operationId: "op-2", status: "succeeded" } }, 201));

    await submit({ cardMode: "new", card: { tokenize: vi.fn(), destroy: vi.fn(), attach: vi.fn() }, storeCard: true, buyerEmail: "payer@example.com" })();

    expect(tokenizeCardMock).toHaveBeenCalledOnce();
    expect(JSON.parse(csrfFetchMock.mock.calls[1]?.[1].body)).toMatchObject({
      sourceId: "card-token",
      sourceKind: "new_card",
      buyerEmail: "payer@example.com",
      storeCard: true,
    });
  });

  it("fails closed without exact canonical selections", async () => {
    await submit({ occurrenceAllocations: [] })();

    expect(csrfFetchMock).not.toHaveBeenCalled();
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ title: "Payment Failed", variant: "destructive" }));
  });
});
