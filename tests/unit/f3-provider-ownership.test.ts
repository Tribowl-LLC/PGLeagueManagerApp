import { describe, expect, it, vi } from "vitest";

const getProvider = vi.hoisted(() => vi.fn());
vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgres://postgres:postgres@127.0.0.1:5432/leaguevault_test";
  process.env.SESSION_SECRET ??= "f3-provider-unit-secret";
  process.env.FIELD_ENCRYPTION_KEY ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
});
vi.mock("../../server/services/payment-provider-factory", () => ({ getPaymentProvider: getProvider }));
vi.mock("../../server/services/payment-utils", () => ({ getProviderCustomerId: (payer: { paymentCustomerId?: string }) => payer.paymentCustomerId ?? null }));

import { validateF3PaymentMethodOwnership } from "../../server/services/f3-workflow";

const league = { locationId: 9 };
const payer = { paymentProviderLocationId: 9, paymentCustomerId: "customer-1" };

function provider(overrides: Record<string, unknown> = {}) {
  return { providerName: "square", validateCardId: vi.fn().mockReturnValue(true), hasCardOnFile: vi.fn().mockResolvedValue(true), paymentsCreate: vi.fn(), refundsCreate: vi.fn(), ...overrides };
}

describe("F3 strict payment-source ownership", () => {
  it("calls the real ownership service with exact customer/card and location", async () => {
    const fake = provider(); getProvider.mockResolvedValue(fake);
    await expect(validateF3PaymentMethodOwnership({ league, payer, sourceId: "card-1" })).resolves.toEqual({ customerId: "customer-1" });
    expect(getProvider).toHaveBeenCalledWith(9);
    expect(fake.hasCardOnFile).toHaveBeenCalledWith("customer-1", "card-1");
    expect(fake.paymentsCreate).not.toHaveBeenCalled();
    expect(fake.refundsCreate).not.toHaveBeenCalled();
  });

  it("rejects location/card drift and maps provider outage without charge/refund/setup", async () => {
    const fake = provider({ hasCardOnFile: vi.fn().mockResolvedValue(false) }); getProvider.mockResolvedValue(fake);
    await expect(validateF3PaymentMethodOwnership({ league, payer, sourceId: "card-1" })).rejects.toMatchObject({ code: "CARD_OWNERSHIP_MISMATCH" });
    expect(fake.paymentsCreate).not.toHaveBeenCalled();
    const outage = provider({ hasCardOnFile: vi.fn().mockRejectedValue(new Error("outage")) }); getProvider.mockResolvedValue(outage);
    await expect(validateF3PaymentMethodOwnership({ league, payer, sourceId: "card-1" })).rejects.toMatchObject({ code: "PAYMENT_PROVIDER_UNAVAILABLE" });
    outage.hasCardOnFile.mockClear();
    await expect(validateF3PaymentMethodOwnership({ league: { locationId: 8 }, payer, sourceId: "card-1" })).rejects.toMatchObject({ code: "PAYMENT_LOCATION_MISMATCH" });
    expect(outage.hasCardOnFile).not.toHaveBeenCalled();
    expect(outage.refundsCreate).not.toHaveBeenCalled();
  });
});
