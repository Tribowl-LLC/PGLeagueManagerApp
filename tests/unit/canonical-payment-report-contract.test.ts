import { describe, expect, it } from "vitest";
import {
  CANONICAL_PAYMENT_REPORT_CONTRACT,
  canonicalPaymentReportFingerprint,
  type CanonicalPaymentReport,
} from "@shared/canonical-payment-report";
import { paymentReceiptContract, PAYMENT_RECEIPT_CONTRACT } from "@shared/payment-receipt";

const base: Omit<CanonicalPaymentReport, "fingerprint"> = {
  contractVersion: CANONICAL_PAYMENT_REPORT_CONTRACT,
  orderVersion: "league,business-date,bowler,occurrence,allocation,payment/1",
  organizationId: 1,
  leagueId: 2,
  mode: "canonical_with_unlinked_history",
  authoritativeSource: "canonical",
  asOf: "2032-01-01T00:00:00.000Z",
  page: 1,
  limit: 50,
  totalRows: 0,
  totalTransactions: 0,
  totals: {
    grossConfirmedPaidMinor: 0,
    activeAllocatedMinor: 0,
    refundedMinor: 0,
    disputedReviewRequiredMinor: 0,
    reviewRequiredMinor: 0,
    unresolvedOperationMinor: 0,
    unallocatedLegacyMinor: 0,
  },
  rows: [],
  transactions: [],
  unlinkedHistory: [],
};

describe("F5 canonical payment and receipt contracts", () => {
  it("fingerprints deterministic report ordering and changes on semantic data", () => {
    const fingerprint = canonicalPaymentReportFingerprint(base);
    expect(fingerprint).toMatch(/^lvpaymentreport:v1:[0-9a-f]{64}$/);
    expect(canonicalPaymentReportFingerprint(base)).toBe(fingerprint);
    expect(canonicalPaymentReportFingerprint({ ...base, totalRows: 1 })).not.toBe(fingerprint);
    expect(canonicalPaymentReportFingerprint({ ...base, asOf: "2033-01-01T00:00:00.000Z" })).toBe(fingerprint);
  });

  it("never infers email delivery from hosted receipt availability", () => {
    const receipt = paymentReceiptContract({ receiptUrl: "https://receipt.test/1", receiptNumber: "R-1" });
    expect(receipt.contractVersion).toBe(PAYMENT_RECEIPT_CONTRACT);
    expect(receipt.availability).toBe("available");
    expect(receipt.deliveryEvidence).toBe("delivery_not_recorded");
    expect(paymentReceiptContract({ receiptUrl: null, receiptNumber: null })).toMatchObject({
      availability: "unavailable",
      deliveryEvidence: "delivery_not_recorded",
    });
  });
});
