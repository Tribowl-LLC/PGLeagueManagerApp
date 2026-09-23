import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isConfirmedSquareCreditRefundFailure,
  isConfirmedNoRefundCreditOutcome,
  isProviderRefundRetryBlocked,
  isRotatingCreditProviderRefundAvailable,
  isRotatingCreditRefundUnresolvedForReversal,
  isSquareCreditRefundDeclined,
  isRotatingCreditRefundHeldStatus,
  previewRotatingCreditApplications,
  spendableRotatingCreditObligationPrefix,
} from "../../server/services/rotating-credit-applications.js";
import { isConfirmedNoChargeDecline } from "@shared/rotating-credit-contract";

const applicationSource = readFileSync(new URL("../../server/services/rotating-credit-applications.ts", import.meta.url), "utf8");
const creditSource = readFileSync(new URL("../../server/services/rotating-credit.ts", import.meta.url), "utf8");
const rosterPaymentSource = readFileSync(new URL("../../server/services/roster-payment-core.ts", import.meta.url), "utf8");
const rotatingPaymentMigration = readFileSync(new URL("../../migrations/0050_rotating_team_payments.sql", import.meta.url), "utf8");

describe("rotating credit ledger safety guards", () => {
  it("locks only application and allocation rows in the reversal query with LEFT JOINs", () => {
    const reversalStart = applicationSource.indexOf("export async function reverseRotatingCreditApplicationsForAssignmentChangeInTransaction");
    expect(reversalStart).toBeGreaterThanOrEqual(0);
    const reversalSource = applicationSource.slice(reversalStart);
    const joinedRead = reversalSource.slice(0, reversalSource.indexOf("const fundingIds"));
    expect(joinedRead).toMatch(/\.for\("update",\s*\{\s*of:\s*\[rotatingCreditApplications,\s*paymentAllocations\]\s*\}\)/);
    expect(joinedRead).not.toMatch(/\.for\("update"\)/);
  });

  it("keeps unresolved action-required refund value out of spendable credit", () => {
    expect(isRotatingCreditRefundHeldStatus("action_required")).toBe(true);
    expect(isRotatingCreditRefundHeldStatus("provider_unknown")).toBe(true);
    expect(isRotatingCreditRefundHeldStatus("succeeded")).toBe(false);
    expect(isRotatingCreditRefundHeldStatus("failed_terminal")).toBe(false);
  });

  it("holds unused lot remainder when an active credit allocation needs review", () => {
    expect(applicationSource).toContain("|| row.allocation.reviewRequired");
  });

  it("stops canonical credit sweeping at the first earlier review-held obligation", () => {
    const firstDate = { billingOrdinal: 1, outstandingMinor: 500, reviewRequired: false };
    const disputedSecondDate = { billingOrdinal: 2, outstandingMinor: 500, reviewRequired: true };
    const laterDate = { billingOrdinal: 3, outstandingMinor: 500, reviewRequired: false };

    expect(spendableRotatingCreditObligationPrefix([firstDate, disputedSecondDate, laterDate]))
      .toEqual([firstDate]);
    expect(spendableRotatingCreditObligationPrefix([disputedSecondDate, laterDate]))
      .toEqual([]);
  });

  it("stops quote previews at the same review boundary as credit application", () => {
    const candidates = [
      { obligationId: "a", occurrenceId: "occ-a", occurrenceLocalDate: "2038-02-01", teamId: 1, slotIndex: 0, outstandingMinor: 400, reviewRequired: false },
      { obligationId: "b", occurrenceId: "occ-b", occurrenceLocalDate: "2038-02-08", teamId: 1, slotIndex: 0, outstandingMinor: 600, reviewRequired: false },
      { obligationId: "c", occurrenceId: "occ-c", occurrenceLocalDate: "2038-02-15", teamId: 1, slotIndex: 0, outstandingMinor: 500, reviewRequired: true },
      { obligationId: "d", occurrenceId: "occ-d", occurrenceLocalDate: "2038-02-22", teamId: 1, slotIndex: 0, outstandingMinor: 300, reviewRequired: false },
    ];

    const preview = previewRotatingCreditApplications(candidates, 700);
    expect(preview).toEqual([
      { obligationId: "a", occurrenceId: "occ-a", occurrenceLocalDate: "2038-02-01", teamId: 1, slotIndex: 0, amountMinor: 400 },
      { obligationId: "b", occurrenceId: "occ-b", occurrenceLocalDate: "2038-02-08", teamId: 1, slotIndex: 0, amountMinor: 300 },
    ]);
    expect(preview.some((row) => row.obligationId === "d")).toBe(false);
    expect(preview.reduce((sum, row) => sum + row.amountMinor, 0)).toBe(700);
  });

  it("marks only a hard decline with no provider object or linked payment as no charge", () => {
    const evidence = {
      status: "action_required" as const,
      errorClassification: "hard_decline",
      providerObjectId: null,
      paymentId: null,
    };
    expect(isConfirmedNoChargeDecline(evidence)).toBe(true);
    expect(isConfirmedNoChargeDecline({ ...evidence, status: "provider_unknown" })).toBe(false);
    expect(isConfirmedNoChargeDecline({ ...evidence, providerObjectId: "sq-payment" })).toBe(false);
    expect(isConfirmedNoChargeDecline({ ...evidence, paymentId: 23 })).toBe(false);
    expect(isConfirmedNoChargeDecline({ ...evidence, errorClassification: "provider_unknown" })).toBe(false);
    expect(creditSource).toContain("confirmedNoChargeDecline: classifyNoChargeDecline({");
    expect(creditSource).toContain("paymentId: payment?.id ?? null");
  });

  it("reapplies released credit to a previously confirmed bowler after assignment correction", () => {
    expect(rosterPaymentSource).toContain("const releasedCreditBowlerIds = new Set<number>();");
    expect(rosterPaymentSource).toContain("if (reversed.length > 0) releasedCreditBowlerIds.add(current.actualBowlerId);");
    expect(rosterPaymentSource).toContain("...releasedCreditBowlerIds,");
  });

  it("makes main-responsibility payer identity explicit in the SQL CHECK", () => {
    expect(rotatingPaymentMigration).toMatch(/responsibility_kind" = 'main'[\s\S]*?payer_bowler_id" IS NOT NULL AND "occurrence_payment_responsibilities"\."payer_bowler_id" =/);
  });

  it("binds provider funding to its Square actor/location and current assignment", () => {
    expect(rotatingPaymentMigration).toContain("operation_row.provider_name IS DISTINCT FROM 'square'");
    expect(rotatingPaymentMigration).toContain("operation_row.authorizing_user_id IS DISTINCT FROM funding_row.actor_user_id");
    expect(rotatingPaymentMigration).toContain("operation_snapshot.location_id IS DISTINCT FROM funding_row.league_location_id");
    expect(rotatingPaymentMigration).toContain("rotating credit funding cannot reuse an ordinary roster charge snapshot");
    expect(rotatingPaymentMigration).toContain("active rotating credit application must match the current confirmed assignment");
    expect(rotatingPaymentMigration).toContain("CREATE CONSTRAINT TRIGGER rotating_credit_assignment_ledger_guard");
  });

  it("releases only Square's confirmed terminal refund rejection", () => {
    expect(isConfirmedSquareCreditRefundFailure({
      status: "failed_terminal",
      providerObjectId: "square-refund-rejected",
      errorClassification: "invalid_request",
      errorCode: "REFUND_REJECTED",
    })).toBe(true);
    expect(isConfirmedSquareCreditRefundFailure({
      status: "failed_terminal",
      providerObjectId: "square-refund-failed",
      errorClassification: "invalid_request",
      errorCode: "REFUND_FAILED",
    })).toBe(true);
    expect(isConfirmedSquareCreditRefundFailure({
      status: "failed_terminal",
      providerObjectId: "square-refund-unknown",
      errorClassification: "provider_unknown",
      errorCode: "REFUND_STATUS_UNRESOLVED",
    })).toBe(false);
    expect(isConfirmedSquareCreditRefundFailure({
      status: "provider_unknown",
      providerObjectId: "square-refund-pending",
      errorClassification: "provider_unknown",
      errorCode: "REFUND_PENDING",
    })).toBe(false);
    const definitePreDispatchFailure = {
      status: "failed_terminal",
      providerObjectId: null,
      errorClassification: "invalid_request",
      errorCode: "SNAPSHOT_INVALID",
    };
    expect(isConfirmedSquareCreditRefundFailure(definitePreDispatchFailure)).toBe(false);
    expect(isConfirmedNoRefundCreditOutcome(definitePreDispatchFailure)).toBe(true);
    expect(isConfirmedNoRefundCreditOutcome({
      status: "failed_terminal",
      providerObjectId: "square-refund-ambiguous",
      errorClassification: "internal",
      errorCode: "LOCAL_FINALIZATION_FAILED",
    })).toBe(false);
    expect(isConfirmedNoRefundCreditOutcome({
      status: "canceled",
      providerObjectId: null,
      errorClassification: null,
      errorCode: null,
    })).toBe(true);
    const issuerDeclined = {
      status: "action_required",
      providerObjectId: null,
      errorClassification: "hard_decline",
      errorCode: "REFUND_DECLINED",
    };
    expect(isSquareCreditRefundDeclined(issuerDeclined)).toBe(true);
    expect(isConfirmedNoRefundCreditOutcome(issuerDeclined)).toBe(true);
    expect(isProviderRefundRetryBlocked(issuerDeclined)).toBe(true);
    expect(isSquareCreditRefundDeclined({
      status: "action_required",
      providerObjectId: null,
      errorClassification: "hard_decline",
      errorCode: "CARD_DECLINED",
    })).toBe(false);
    expect(isConfirmedNoRefundCreditOutcome({
      status: "action_required",
      providerObjectId: null,
      errorClassification: "hard_decline",
      errorCode: "CARD_DECLINED",
    })).toBe(false);
  });

  it("allows reversal after a confirmed refund decline but holds ambiguous action-required outcomes", () => {
    const confirmedDecline = {
      status: "action_required",
      providerObjectId: null,
      errorClassification: "hard_decline",
      errorCode: "REFUND_DECLINED",
    };
    const ambiguousActionRequired = {
      status: "action_required",
      providerObjectId: null,
      errorClassification: "hard_decline",
      errorCode: "CARD_DECLINED",
    };
    const reversalStart = applicationSource.indexOf("export async function reverseRotatingCreditApplicationsForAssignmentChangeInTransaction");
    const reversalSource = applicationSource.slice(reversalStart);

    expect(isConfirmedNoRefundCreditOutcome(confirmedDecline)).toBe(true);
    expect(isRotatingCreditRefundUnresolvedForReversal(confirmedDecline)).toBe(false);
    expect(isConfirmedNoRefundCreditOutcome(ambiguousActionRequired)).toBe(false);
    expect(isRotatingCreditRefundUnresolvedForReversal(ambiguousActionRequired)).toBe(true);
    expect(reversalSource).toContain("isRotatingCreditRefundUnresolvedForReversal(row.operation)");
  });

  it("offers provider refunds only for verified Square card tenders with no terminal retry block", () => {
    const validSource = {
      organizationId: 11,
      leagueId: 7,
      fundingKind: "provider",
      fundingAmountMinor: 1_000,
      fundingCurrency: "USD",
      paymentStatus: "paid",
      paymentAmountMinor: 1_000,
      paymentCurrency: "USD",
      paymentType: "credit_card",
      paymentOperationId: "charge-operation",
      providerPaymentId: "square-payment",
      locationId: 19,
      operation: {
        id: "charge-operation",
        organizationId: 11,
        leagueId: 7,
        operationType: "interactive_charge",
        status: "succeeded",
        providerName: "square",
        providerObjectId: "square-payment",
        amountMinor: 1_000,
        currency: "USD",
      },
      priorProviderRefundOperations: [],
    };
    expect(isRotatingCreditProviderRefundAvailable(validSource)).toBe(true);
    expect(isRotatingCreditProviderRefundAvailable({
      ...validSource,
      priorProviderRefundOperations: [{
        status: "action_required",
        providerObjectId: null,
        errorClassification: "hard_decline",
        errorCode: "REFUND_DECLINED",
      }],
    })).toBe(false);
    expect(isRotatingCreditProviderRefundAvailable({
      ...validSource,
      priorProviderRefundOperations: [{
        status: "failed_terminal",
        providerObjectId: "square-refund-rejected",
        errorClassification: "invalid_request",
        errorCode: "REFUND_REJECTED",
      }],
    })).toBe(false);
    expect(isRotatingCreditProviderRefundAvailable({
      ...validSource,
      priorProviderRefundOperations: [{
        status: "failed_terminal",
        providerObjectId: null,
        errorClassification: "invalid_request",
        errorCode: "SNAPSHOT_INVALID",
      }],
    })).toBe(true);
    expect(isRotatingCreditProviderRefundAvailable({ ...validSource, providerPaymentId: "different-square-payment" })).toBe(false);
    expect(isRotatingCreditProviderRefundAvailable({ ...validSource, operation: null })).toBe(false);
    expect(isRotatingCreditProviderRefundAvailable({ ...validSource, locationId: null })).toBe(false);
  });

  it("checks manual funding idempotent replay before current eligibility and quote", () => {
    const start = creditSource.indexOf("export async function recordRotatingCreditManualFunding");
    const end = creditSource.indexOf("export async function chargeRotatingCreditPurchase", start);
    const manualSource = creditSource.slice(start, end);
    expect(manualSource.indexOf("if (existingFunding)")).toBeGreaterThanOrEqual(0);
    expect(manualSource.indexOf("if (existingFunding)")).toBeLessThan(manualSource.indexOf("readRotatingCreditTermsInTransaction"));
    expect(manualSource).toContain("existingFunding.funding.requestFingerprint !== requestFingerprint");
  });

  it("validates and recovers a matching card operation before current terms", () => {
    const start = creditSource.indexOf("export async function chargeRotatingCreditPurchase");
    const end = creditSource.indexOf("export async function buildRotatingCreditOperationWire", start);
    const chargeSource = creditSource.slice(start, end);
    expect(chargeSource.indexOf("findExistingRotatingCreditChargeInTransaction")).toBeLessThan(chargeSource.indexOf("readRotatingCreditTermsInTransaction"));
    expect(chargeSource).toContain("recoverRotatingCreditChargeOperation({");
    expect(creditSource).toContain("snapshot.sourceId === input.request.sourceId");
    expect(creditSource).toContain("snapshot.quoteFingerprint === input.request.quoteFingerprint");
    expect(creditSource).toContain("snapshot.idempotencyKey === input.request.idempotencyKey");
  });
});
