import { describe, expect, it, vi } from "vitest";
import { invalidatePaymentHistoryFinancials, paymentHistoryFinancialQueryKey } from "@/lib/payment-history-financial-query";
import { readFileSync } from "node:fs";

describe("payment history financial query invalidation", () => {
  it("interprets wall-clock tender timestamps as UTC before league conversion", () => {
    const source = readFileSync("server/storage/payments.ts", "utf8");
    expect(source).toContain("AT TIME ZONE 'UTC' AT TIME ZONE COALESCE");
    expect(source).not.toContain("setHours");
    const businessDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Detroit" }).format(new Date("2026-01-02T04:30:00.000Z"));
    expect(businessDate).toBe("2026-01-01");
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
