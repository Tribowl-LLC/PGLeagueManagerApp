import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useForm } from "react-hook-form";
import type { InsertPayment, InsertPaymentInput } from "@shared/schema";

const mocks = vi.hoisted(() => ({
  csrfFetch: vi.fn(),
  toast: vi.fn(),
  navigate: vi.fn(),
  clearPaymentIntent: vi.fn((_scope: string, _expectedRequestKey?: string) => undefined),
  paymentRequestWithRecovery: vi.fn(async (_key: string, submit: () => Promise<Response>, _leagueId?: number) => submit()),
  paymentRequestHeaders: vi.fn((key: string) => ({ "Idempotency-Key": key })),
  beginPaymentIntent: vi.fn((_scope: string) => "manual-payment-request-key-001"),
}));

vi.mock("@/lib/queryClient", () => ({ csrfFetch: (...args: unknown[]) => mocks.csrfFetch(...args) }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: (...args: unknown[]) => mocks.toast(...args) }) }));
vi.mock("wouter", () => ({ useLocation: () => ["/payments", mocks.navigate] }));
vi.mock("@/lib/payment-request-identity", async () => {
  const actual = await vi.importActual<typeof import("@/lib/payment-request-identity")>("@/lib/payment-request-identity");
  return {
    ...actual,
    beginPaymentIntent: (scope: string) => mocks.beginPaymentIntent(scope),
    clearPaymentIntent: (scope: string, expectedRequestKey?: string) => mocks.clearPaymentIntent(scope, expectedRequestKey),
    paymentRequestHeaders: (key: string) => mocks.paymentRequestHeaders(key),
    paymentRequestWithRecovery: (key: string, submit: () => Promise<Response>, leagueId?: number) => mocks.paymentRequestWithRecovery(key, submit, leagueId),
  };
});

import { usePaymentFormSubmit } from "@/hooks/use-payment-form-submit";

function queryWrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe("single manual payment submission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.beginPaymentIntent.mockReturnValue("manual-payment-request-key-001");
    mocks.paymentRequestWithRecovery.mockImplementation(async (_key, submit) => submit());
    mocks.csrfFetch.mockImplementation(async (url: string) => url.includes("/quote/")
      ? new Response(JSON.stringify({ data: { fingerprint: "manual-quote-fingerprint" } }), { status: 200 })
      : new Response(JSON.stringify({ data: { payment: { id: 9 } } }), { status: 201 }));
  });

  it("quotes and records the exact cash/check identity through the manual receipt API", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const submitHook = renderHook(() => {
      const form = useForm<InsertPaymentInput, unknown, InsertPayment>();
      return usePaymentFormSubmit({
        form,
        card: null,
        cardMode: "new",
        selectedSavedCardId: "",
        setPaymentError: vi.fn(),
        onClose: vi.fn(),
        organizationId: 11,
        actorUserId: 3,
      });
    }, { wrapper: queryWrapper(client) });
    const payment = {
      leagueId: 7,
      bowlerId: 42,
      amount: 1_234,
      currency: "USD",
      status: "paid",
      type: "check",
      checkNumber: "0042",
      notes: "front desk receipt",
      receiptEmailMissing: false,
    } satisfies InsertPayment;

    await act(async () => { await submitHook.result.current(payment); });

    expect(mocks.csrfFetch).toHaveBeenCalledTimes(2);
    expect(mocks.csrfFetch.mock.calls[0]?.[0]).toBe("/api/financials/leagues/7/canonical/manual-record/quote/1");
    expect(JSON.parse(String(mocks.csrfFetch.mock.calls[0]?.[1]?.body))).toEqual({
      amountMinor: 1_234,
      payerBowlerId: 42,
      type: "check",
      checkNumber: "0042",
      notes: "front desk receipt",
    });
    expect(mocks.csrfFetch.mock.calls[1]?.[0]).toBe("/api/financials/leagues/7/canonical/manual-record/1");
    expect(JSON.parse(String(mocks.csrfFetch.mock.calls[1]?.[1]?.body)).requestFingerprint).toBe("manual-quote-fingerprint");
    expect(JSON.parse(String(mocks.csrfFetch.mock.calls[1]?.[1]?.body))).toMatchObject({
      amountMinor: 1_234,
      payerBowlerId: 42,
      type: "check",
      checkNumber: "0042",
      notes: "front desk receipt",
    });
    expect(mocks.paymentRequestWithRecovery).toHaveBeenCalledWith(
      "manual-payment-request-key-001",
      expect.any(Function),
      undefined,
    );
  });
});
