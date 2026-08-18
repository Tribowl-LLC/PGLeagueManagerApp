import { describe, expect, it, vi } from "vitest";
import { invalidatePaymentHistoryFinancials, paymentHistoryFinancialQueryKey } from "@/lib/payment-history-financial-query";

describe("payment history financial query invalidation", () => {
  it("invalidates and awaits the exact F1 due-past-due key used by checkout", async () => {
    const client = { invalidateQueries: vi.fn().mockResolvedValue(undefined) };
    await invalidatePaymentHistoryFinancials(client, 42, 7);
    expect(client.invalidateQueries).toHaveBeenCalledOnce();
    expect(client.invalidateQueries).toHaveBeenCalledWith({
      queryKey: paymentHistoryFinancialQueryKey(42, 7),
    });
  });
});
