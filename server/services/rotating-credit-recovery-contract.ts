const RETRYABLE_LOCAL_CREDIT_FINALIZATION_CODES = new Set([
  "PAYMENT_EVIDENCE_INCOMPLETE",
  "FUNDING_CREATE_FAILED",
  "CREDIT_ALLOCATION_CREATE_FAILED",
  "CREDIT_APPLICATION_CREATE_FAILED",
]);

/** A retained provider object ID is not proof the charge completed. Only a
 * known internal finalization failure may re-run the local credit finalizer. */
export function isRotatingCreditFinalizationRecoveryEligible(operation: {
  status: string;
  errorClassification: string | null;
  errorCode: string | null;
  providerObjectId: string | null;
}): boolean {
  return operation.status === "reconciliation_required"
    && operation.errorClassification === "internal"
    && operation.providerObjectId !== null
    && operation.errorCode !== null
    && RETRYABLE_LOCAL_CREDIT_FINALIZATION_CODES.has(operation.errorCode);
}
