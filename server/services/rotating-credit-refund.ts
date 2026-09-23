import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  leagues,
  paymentOperations,
  payments,
  rotatingCreditFundings,
  rotatingCreditRefunds,
  rotatingCreditRefundOperationSnapshots,
} from "@shared/schema";
import type {
  RotatingCreditRefundOperationWire,
  RotatingCreditRefundQuoteWire,
  RotatingCreditRefundRequest,
} from "@shared/rotating-credit-contract";
import { isCardPaymentType } from "@shared/schema/constants";
import { db } from "../db.js";
import {
  createOrGetRotatingCreditRefundPaymentOperation,
  persistRotatingCreditRefundPaymentOperationSnapshot,
  type PaymentOperationTransaction,
} from "../storage/payment-operations.js";
import { lockLeagueSchedule } from "../storage/league-schedule-lock.js";
import { refundPaymentOperationExecutor } from "./refund-payment-operation-executor.js";
import type { RefundPaymentOperationExecutor } from "./refund-payment-operation-executor.js";
import {
  isRotatingCreditProviderRefundAvailable,
  isProviderRefundRetryBlocked,
  readRotatingCreditFundingBalancesInTransaction,
} from "./rotating-credit-applications.js";
import { readRotatingCreditBalance } from "./rotating-credit.js";
import { canonicalizePaymentOperationInput } from "./payment-operation-idempotency.js";
import { reconstructRotatingCreditRefundSnapshot } from "./rotating-credit-refund-snapshot.js";

export class RotatingCreditRefundError extends Error {
  constructor(public readonly code: string, public readonly status = 409) {
    super("Unable to process rotating credit refund request");
    this.name = "RotatingCreditRefundError";
  }
}

function refundQuoteFingerprint(input: {
  organizationId: number;
  leagueId: number;
  fundingId: string;
  paymentId: number;
  bowlerId: number;
  amountMinor: number;
}): string {
  const normalized = {
    contract: "rotating-credit-refund-quote/1",
    organizationId: input.organizationId,
    leagueId: input.leagueId,
    fundingId: input.fundingId,
    paymentId: input.paymentId,
    bowlerId: input.bowlerId,
    amountMinor: input.amountMinor,
    currency: "USD",
  };
  const digest = createHash("sha256").update(canonicalizePaymentOperationInput(normalized)).digest("hex");
  return `lvrotcrrefundquote:v1:${digest}`;
}

function refundRequestFingerprint(input: {
  organizationId: number;
  leagueId: number;
  fundingId: string;
  actorUserId: number;
  request: RotatingCreditRefundRequest;
}): string {
  const digest = createHash("sha256").update(canonicalizePaymentOperationInput({
    contract: "rotating-credit-refund-request/1",
    organizationId: input.organizationId,
    leagueId: input.leagueId,
    fundingId: input.fundingId,
    actorUserId: input.actorUserId,
    refundKind: input.request.refundKind,
    quoteFingerprint: input.request.quoteFingerprint,
    idempotencyKey: input.request.idempotencyKey,
    reason: input.request.reason.trim(),
    reference: input.request.reference?.trim() ?? null,
  })).digest("hex");
  return `lvrotcrrefund:v1:${digest}`;
}

function refundTargetKey(fundingId: string, idempotencyKey: string): string {
  const digest = createHash("sha256").update(canonicalizePaymentOperationInput({
    contract: "rotating-credit-refund-target/1",
    fundingId,
    idempotencyKey,
  })).digest("hex");
  return `rotating-credit-refund:${fundingId}:${digest}`;
}

async function readRefundLotInTransaction(
  tx: PaymentOperationTransaction,
  input: { organizationId: number; leagueId: number; fundingId: string },
) {
  const [owned] = await tx.select({ funding: rotatingCreditFundings, payment: payments, league: leagues, operation: paymentOperations })
    .from(rotatingCreditFundings)
    .innerJoin(payments, and(
      eq(payments.id, rotatingCreditFundings.paymentId),
      eq(payments.organizationId, input.organizationId),
      eq(payments.leagueId, input.leagueId),
    ))
    .leftJoin(paymentOperations, eq(paymentOperations.id, payments.paymentOperationId))
    .innerJoin(leagues, and(
      eq(leagues.id, rotatingCreditFundings.leagueId),
      eq(leagues.organizationId, rotatingCreditFundings.organizationId),
    ))
    .where(and(
      eq(rotatingCreditFundings.id, input.fundingId),
      eq(rotatingCreditFundings.organizationId, input.organizationId),
      eq(rotatingCreditFundings.leagueId, input.leagueId),
    )).limit(1).for("update", { of: [rotatingCreditFundings, payments] });
  if (!owned) throw new RotatingCreditRefundError("CREDIT_LOT_NOT_FOUND", 404);
  const [balance] = (await readRotatingCreditFundingBalancesInTransaction(tx, {
    organizationId: input.organizationId,
    leagueId: input.leagueId,
    bowlerId: owned.funding.bowlerId,
  })).filter((row) => row.fundingId === owned.funding.id);
  if (!balance) throw new RotatingCreditRefundError("CREDIT_BALANCE_EVIDENCE_MISSING");
  if (balance.reviewRequired) throw new RotatingCreditRefundError("CREDIT_LOT_REQUIRES_REVIEW");
  if (balance.refundHeldMinor > 0) throw new RotatingCreditRefundError("CREDIT_REFUND_PENDING");
  if (balance.availableMinor <= 0) throw new RotatingCreditRefundError("NO_UNUSED_CREDIT", 400);
  return { ...owned, balance };
}

export async function quoteRotatingCreditRefund(input: {
  organizationId: number;
  leagueId: number;
  fundingId: string;
}): Promise<RotatingCreditRefundQuoteWire> {
  return db.transaction(async (tx) => {
    const lot = await readRefundLotInTransaction(tx, input);
    const priorProviderRefunds = await tx.select({ operation: paymentOperations })
      .from(rotatingCreditRefunds)
      .innerJoin(paymentOperations, and(
        eq(paymentOperations.id, rotatingCreditRefunds.refundOperationId),
        eq(paymentOperations.organizationId, input.organizationId),
        eq(paymentOperations.leagueId, input.leagueId),
        eq(paymentOperations.operationType, "refund"),
      ))
      .where(and(
        eq(rotatingCreditRefunds.organizationId, input.organizationId),
        eq(rotatingCreditRefunds.leagueId, input.leagueId),
        eq(rotatingCreditRefunds.fundingId, lot.funding.id),
        eq(rotatingCreditRefunds.refundKind, "provider"),
      ));
    const providerRefundAvailable = isRotatingCreditProviderRefundAvailable({
      fundingKind: lot.funding.fundingKind,
      fundingAmountMinor: lot.funding.amountMinor,
      fundingCurrency: lot.funding.currency,
      paymentStatus: lot.payment.status,
      paymentAmountMinor: lot.payment.amount,
      paymentCurrency: lot.payment.currency,
      paymentType: lot.payment.type,
      paymentOperationId: lot.payment.paymentOperationId,
      providerPaymentId: lot.payment.providerPaymentId,
      locationId: lot.league.locationId,
      operation: lot.operation,
      priorProviderRefundOperations: priorProviderRefunds.map(({ operation }) => operation),
      organizationId: input.organizationId,
      leagueId: input.leagueId,
    });
    return {
      contractVersion: "rotating-credit-refund-quote/1",
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      bowlerId: lot.funding.bowlerId,
      fundingId: lot.funding.id,
      paymentId: lot.payment.id,
      currency: "USD",
      amountMinor: lot.balance.availableMinor,
      providerRefundAvailable,
      fingerprint: refundQuoteFingerprint({
        organizationId: input.organizationId,
        leagueId: input.leagueId,
        fundingId: lot.funding.id,
        paymentId: lot.payment.id,
        bowlerId: lot.funding.bowlerId,
        amountMinor: lot.balance.availableMinor,
      }),
    };
  });
}

async function makeRefundWire(input: {
  organizationId: number;
  leagueId: number;
  bowlerId: number;
  refundId: string;
  operation: { id: string; status: RotatingCreditRefundOperationWire["status"]; providerObjectId: string | null } | null;
  amountMinor: number;
}): Promise<RotatingCreditRefundOperationWire> {
  return {
    contractVersion: "rotating-credit-refund-operation/1",
    refundId: input.refundId,
    operationId: input.operation?.id ?? null,
    status: input.operation?.status ?? "succeeded",
    amountMinor: input.amountMinor,
    providerRefundId: input.operation?.providerObjectId ?? null,
    balance: await readRotatingCreditBalance({
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      bowlerId: input.bowlerId,
    }),
  };
}

export async function recordRotatingCreditRefund(input: {
  organizationId: number;
  leagueId: number;
  actorUserId: number;
  request: RotatingCreditRefundRequest;
  executor?: RefundPaymentOperationExecutor;
}): Promise<RotatingCreditRefundOperationWire> {
  const requestFingerprint = refundRequestFingerprint({
    organizationId: input.organizationId,
    leagueId: input.leagueId,
    fundingId: input.request.fundingId,
    actorUserId: input.actorUserId,
    request: input.request,
  });
  const prepared = await db.transaction(async (tx) => {
    await lockLeagueSchedule(tx, input.organizationId, input.leagueId);
    const [existingRefund] = await tx.select().from(rotatingCreditRefunds).where(and(
        eq(rotatingCreditRefunds.organizationId, input.organizationId),
        eq(rotatingCreditRefunds.leagueId, input.leagueId),
        eq(rotatingCreditRefunds.idempotencyKey, input.request.idempotencyKey),
      )).limit(1).for("update");
    if (existingRefund) {
      const [existingOperation] = existingRefund.refundOperationId === null ? [] : await tx.select().from(paymentOperations).where(and(
        eq(paymentOperations.organizationId, input.organizationId),
        eq(paymentOperations.leagueId, input.leagueId),
        eq(paymentOperations.id, existingRefund.refundOperationId),
        eq(paymentOperations.operationType, "refund"),
      )).limit(1).for("share");
      if (existingRefund.fundingId !== input.request.fundingId
        || existingRefund.actorUserId !== input.actorUserId
        || existingRefund.currency !== "USD"
        || existingRefund.idempotencyKey !== input.request.idempotencyKey
        || existingRefund.refundKind !== input.request.refundKind
        || existingRefund.reason !== input.request.reason.trim()
        || existingRefund.reference !== (input.request.reference?.trim() ?? null)
        || existingRefund.requestFingerprint !== requestFingerprint) {
        throw new RotatingCreditRefundError("IDEMPOTENCY_CONFLICT");
      }
      const [funding] = await tx.select({
        bowlerId: rotatingCreditFundings.bowlerId,
        fundingKind: rotatingCreditFundings.fundingKind,
        paymentId: rotatingCreditFundings.paymentId,
        amountMinor: rotatingCreditFundings.amountMinor,
        currency: rotatingCreditFundings.currency,
        paymentStatus: payments.status,
        paymentAmount: payments.amount,
        paymentCurrency: payments.currency,
        paymentType: payments.type,
        providerPaymentId: payments.providerPaymentId,
        locationId: leagues.locationId,
      }).from(rotatingCreditFundings)
        .innerJoin(payments, and(
          eq(payments.id, rotatingCreditFundings.paymentId),
          eq(payments.organizationId, input.organizationId),
          eq(payments.leagueId, input.leagueId),
        ))
        .innerJoin(leagues, and(
          eq(leagues.id, rotatingCreditFundings.leagueId),
          eq(leagues.organizationId, rotatingCreditFundings.organizationId),
        ))
        .where(and(
          eq(rotatingCreditFundings.id, existingRefund.fundingId),
          eq(rotatingCreditFundings.organizationId, input.organizationId),
          eq(rotatingCreditFundings.leagueId, input.leagueId),
        )).limit(1);
      if (!funding) throw new RotatingCreditRefundError("CREDIT_LOT_NOT_FOUND", 404);
      if (existingRefund.refundKind === "provider") {
        if (!existingOperation) throw new RotatingCreditRefundError("REFUND_OPERATION_MISSING");
        const [storedSnapshot] = await tx.select().from(rotatingCreditRefundOperationSnapshots).where(and(
          eq(rotatingCreditRefundOperationSnapshots.operationId, existingOperation.id),
          eq(rotatingCreditRefundOperationSnapshots.organizationId, input.organizationId),
          eq(rotatingCreditRefundOperationSnapshots.leagueId, input.leagueId),
        )).limit(1).for("share");
        let snapshot;
        try {
          if (!storedSnapshot) throw new Error("refund snapshot is missing");
          snapshot = reconstructRotatingCreditRefundSnapshot({ operation: existingOperation, stored: storedSnapshot });
        } catch {
          throw new RotatingCreditRefundError("REFUND_OPERATION_MISMATCH");
        }
        if (existingOperation.authorizingUserId !== input.actorUserId
          || existingOperation.targetKey !== refundTargetKey(existingRefund.fundingId, existingRefund.idempotencyKey)
          || existingOperation.amountMinor !== existingRefund.amountMinor
          || existingOperation.currency !== "USD"
          || existingOperation.providerName !== "square"
          || (existingOperation.status === "succeeded" && existingOperation.providerObjectId === null)
          || snapshot.fundingId !== existingRefund.fundingId
          || snapshot.paymentId !== existingRefund.paymentId
          || snapshot.bowlerId !== existingRefund.bowlerId
          || snapshot.amountMinor !== existingRefund.amountMinor
          || snapshot.currency !== existingRefund.currency
          || snapshot.reason !== existingRefund.reason
          || funding.fundingKind !== "provider"
          || funding.bowlerId !== existingRefund.bowlerId
          || funding.paymentId !== existingRefund.paymentId
          || existingRefund.amountMinor <= 0
          || existingRefund.amountMinor > funding.amountMinor
          || funding.currency !== existingRefund.currency
          || funding.paymentStatus !== "paid"
          || funding.paymentAmount !== funding.amountMinor
          || funding.paymentCurrency !== funding.currency
          || !isCardPaymentType(funding.paymentType)
          || !funding.providerPaymentId
          || funding.locationId === null
          || snapshot.providerPaymentId !== funding.providerPaymentId
          || snapshot.locationId !== funding.locationId) {
          throw new RotatingCreditRefundError("REFUND_OPERATION_MISMATCH");
        }
      }
      return { refund: existingRefund, operation: existingOperation ?? null, bowlerId: funding.bowlerId, replay: true };
    }

    const lot = await readRefundLotInTransaction(tx, {
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      fundingId: input.request.fundingId,
    });
    const expectedFingerprint = refundQuoteFingerprint({
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      fundingId: lot.funding.id,
      paymentId: lot.payment.id,
      bowlerId: lot.funding.bowlerId,
      amountMinor: lot.balance.availableMinor,
    });
    if (expectedFingerprint !== input.request.quoteFingerprint) throw new RotatingCreditRefundError("STALE_REFUND_QUOTE");
    if (lot.payment.status !== "paid" || lot.payment.amount !== lot.funding.amountMinor || lot.payment.currency !== "USD") {
      throw new RotatingCreditRefundError("CREDIT_FUNDING_REQUIRES_REVIEW");
    }

    const now = new Date().toISOString();
    let operation: typeof paymentOperations.$inferSelect | null = null;
    if (input.request.refundKind === "provider") {
      if (lot.funding.fundingKind !== "provider" || !isCardPaymentType(lot.payment.type)
        || !lot.payment.providerPaymentId || lot.league.locationId === null) {
        throw new RotatingCreditRefundError("PROVIDER_REFUND_UNAVAILABLE", 400);
      }
      const priorProviderRefunds = await tx.select({ operation: paymentOperations })
        .from(rotatingCreditRefunds)
        .innerJoin(paymentOperations, and(
          eq(paymentOperations.id, rotatingCreditRefunds.refundOperationId),
          eq(paymentOperations.organizationId, input.organizationId),
          eq(paymentOperations.leagueId, input.leagueId),
        ))
        .where(and(
          eq(rotatingCreditRefunds.organizationId, input.organizationId),
          eq(rotatingCreditRefunds.leagueId, input.leagueId),
          eq(rotatingCreditRefunds.fundingId, lot.funding.id),
          eq(rotatingCreditRefunds.refundKind, "provider"),
        ));
      if (priorProviderRefunds.some(({ operation: prior }) => isProviderRefundRetryBlocked(prior))) {
        throw new RotatingCreditRefundError("PROVIDER_REFUND_UNAVAILABLE", 400);
      }
      operation = await createOrGetRotatingCreditRefundPaymentOperation({
        organizationId: input.organizationId,
        leagueId: input.leagueId,
        targetKey: refundTargetKey(lot.funding.id, input.request.idempotencyKey),
        amountMinor: lot.balance.availableMinor,
        currency: "USD",
        providerName: "square",
        authorizingUserId: input.actorUserId,
        now: new Date(now),
      }, tx);
      const snapshot = await persistRotatingCreditRefundPaymentOperationSnapshot(operation, {
        organizationId: input.organizationId,
        leagueId: input.leagueId,
        fundingId: lot.funding.id,
        paymentId: lot.payment.id,
        bowlerId: lot.funding.bowlerId,
        amountMinor: lot.balance.availableMinor,
        currency: "USD",
        providerName: "square",
        providerPaymentId: lot.payment.providerPaymentId,
        locationId: lot.league.locationId,
        reason: input.request.reason.trim(),
      }, tx);
      const [refund] = await tx.insert(rotatingCreditRefunds).values({
        organizationId: input.organizationId,
        leagueId: input.leagueId,
        fundingId: lot.funding.id,
        paymentId: lot.payment.id,
        bowlerId: lot.funding.bowlerId,
        amountMinor: lot.balance.availableMinor,
        currency: "USD",
        refundKind: "provider",
        refundOperationId: operation.id,
        reason: input.request.reason.trim(),
        actorUserId: input.actorUserId,
        idempotencyKey: input.request.idempotencyKey,
        requestFingerprint,
        createdAt: now,
      }).returning();
      if (!refund || snapshot.snapshotFingerprint.length === 0) throw new RotatingCreditRefundError("REFUND_EVIDENCE_CREATE_FAILED", 500);
      return { refund, operation, bowlerId: lot.funding.bowlerId, replay: false };
    }

    const reference = input.request.reference?.trim();
    if (!reference) throw new RotatingCreditRefundError("REFUND_REFERENCE_REQUIRED", 400);
    const [refund] = await tx.insert(rotatingCreditRefunds).values({
      organizationId: input.organizationId,
      leagueId: input.leagueId,
      fundingId: lot.funding.id,
      paymentId: lot.payment.id,
      bowlerId: lot.funding.bowlerId,
      amountMinor: lot.balance.availableMinor,
      currency: "USD",
      refundKind: input.request.refundKind,
      reference,
      reason: input.request.reason.trim(),
      actorUserId: input.actorUserId,
      idempotencyKey: input.request.idempotencyKey,
      requestFingerprint,
      issuedAt: now,
      createdAt: now,
    }).returning();
    if (!refund) throw new RotatingCreditRefundError("REFUND_EVIDENCE_CREATE_FAILED", 500);
    return { refund, operation, bowlerId: lot.funding.bowlerId, replay: false };
  });

  let operation = prepared.operation;
  if (operation && !["succeeded", "failed_terminal", "canceled", "action_required", "reconciliation_required"].includes(operation.status)) {
    const executor = input.executor ?? refundPaymentOperationExecutor;
    operation = await executor.execute({ organizationId: input.organizationId, operationId: operation.id }) ?? operation;
  }
  return makeRefundWire({
    organizationId: input.organizationId,
    leagueId: input.leagueId,
    bowlerId: prepared.bowlerId,
    refundId: prepared.refund.id,
    operation,
    amountMinor: prepared.refund.amountMinor,
  });
}
