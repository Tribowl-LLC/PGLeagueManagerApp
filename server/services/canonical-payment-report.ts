/**
 * Compatibility entry point for retained receipt/report consumers.
 *
 * The roster archive is the only canonical implementation after migration
 * 0032; this module intentionally contains no table access of its own.
 */
export {
  CanonicalPaymentReportIncompatibilityError,
  readCanonicalPaymentReport,
  readPaymentReceiptProjection,
} from "./roster-payment-archive-report.js";
