import { describe, expect, it, vi } from "vitest";
import { invalidatePaymentHistoryFinancials, paymentHistoryFinancialQueryKey } from "@/lib/payment-history-financial-query";
import { readFileSync } from "node:fs";

describe("payment history financial query invalidation", () => {
  it("keeps date filtering in the league business timezone", () => {
    const source = readFileSync("server/storage/payments.ts", "utf8");
    expect(source).toContain("AT TIME ZONE");
    expect(source).not.toContain("setHours");
  });
  it("invalidates and awaits the exact F1 due-past-due key used by checkout", async () => {
    const client = { invalidateQueries: vi.fn().mockResolvedValue(undefined) };
    await invalidatePaymentHistoryFinancials(client, 42, 7);
    expect(client.invalidateQueries).toHaveBeenCalledOnce();
    expect(client.invalidateQueries).toHaveBeenCalledWith({
      queryKey: paymentHistoryFinancialQueryKey(42, 7),
    });
  });
});
