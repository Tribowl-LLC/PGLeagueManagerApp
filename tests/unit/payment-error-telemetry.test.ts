import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PaymentProviderError,
  ProviderNotConfiguredError,
} from "../../server/services/payment-errors";
import { captureUnexpectedPaymentProviderError } from "../../server/services/payment-error-telemetry";
import { configureServerErrorReporter, createLogger } from "../../server/logger";

afterEach(() => {
  configureServerErrorReporter(null);
});

describe("payment provider telemetry classification", () => {
  it.each([
    [
      new PaymentProviderError("Your payment was declined.", "PAYMENT_DECLINED"),
      false,
      "terminal decline",
    ],
    [
      new PaymentProviderError("Payment provider is busy.", "PAYMENT_FAILED", undefined, { disposition: "transient" }),
      true,
      "transient provider failure",
    ],
    [
      new PaymentProviderError("Payment outcome is unresolved.", "PAYMENT_FAILED", undefined, { disposition: "provider_unknown" }),
      true,
      "unknown provider outcome",
    ],
    [
      new ProviderNotConfiguredError("Square is not configured", 7),
      true,
      "provider unavailable",
    ],
    [
      new PaymentProviderError("Payment service failed.", "PAYMENT_FAILED", undefined, { disposition: "internal" }),
      true,
      "internal failure",
    ],
  ])("captures %s when expected", (failure, shouldCapture, _description) => {
    const reporter = { captureException: vi.fn() };

    captureUnexpectedPaymentProviderError(reporter, failure);

    if (shouldCapture) {
      expect(reporter.captureException).toHaveBeenCalledOnce();
      expect(reporter.captureException).toHaveBeenCalledWith(failure);
    } else {
      expect(reporter.captureException).not.toHaveBeenCalled();
    }
  });

  it("preserves the raw error and uses the logger cause-chain dedupe", () => {
    const reporter = vi.fn();
    configureServerErrorReporter(reporter);
    const cause = new Error("Square transport timeout");
    const failure = new PaymentProviderError("Payment outcome is unresolved.", "PAYMENT_FAILED", undefined, {
      disposition: "provider_unknown",
      providerCode: "TRANSPORT_UNKNOWN",
    });
    Object.defineProperty(failure, "cause", { value: cause });
    const log = createLogger("PaymentTelemetryTest");

    captureUnexpectedPaymentProviderError(log, failure);
    captureUnexpectedPaymentProviderError(log, failure);

    expect(reporter).toHaveBeenCalledOnce();
    expect(reporter).toHaveBeenCalledWith(failure, { logger: "PaymentTelemetryTest" });
  });
});
