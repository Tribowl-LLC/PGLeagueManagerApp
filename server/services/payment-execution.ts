import { db } from "../db";
import { eq, and, lte, gte, sql } from "drizzle-orm";
import { payments, leagues, bowlers, DEFAULT_TIMEZONE, type PaymentSchedule } from "@shared/schema";
import { providerNameToPaymentType } from "@shared/schema/constants";
import { toZonedTime } from "date-fns-tz";
import { toIsoDateStr } from "@shared/schedule-utils";
import { logger } from "../logger";
import { getPaymentProvider, ProviderNotConfiguredError } from "./payment-provider-factory";
import { buildPaymentErrorResponse } from "../utils/payment-error-response";
import type { PaymentProvider, OrderLineItem } from "./payment-provider";

export interface ChargeResult {
  status: 'success' | 'error';
  paymentId?: string;
  error?: string;
  cardId?: string;
  providerRef?: Record<string, string>;
  providerName?: string;
  // Square hosted-receipt fields.
  receiptUrl?: string;
  receiptNumber?: string;
  // True when a Square charge ran without buyer email (no auto-receipt).
  buyerEmailMissing?: boolean;
  // Task #646: the actual amount charged to the provider. May differ
  // from the schedule's stored `amount` (e.g. 2× on double-pay weeks).
  // Callers that insert payment rows must use this value, not
  // `scheduleRecord.amount`, so the persisted record matches what was
  // actually billed.
  chargedAmount?: number;
  // Task #646: true when this scheduled charge fired on one of the
  // league's double-pay dates (i.e. `chargedAmount === 2 × weeklyFee`).
  // The lifecycle uses this to stamp the persisted payment row's
  // `notes` so admins can identify double-pay charges in the audit log.
  isDoublePay?: boolean;
}

async function fetchBowlerPaymentInfo(bowlerId: number) {
  const bowler = await db.select().from(bowlers).where(eq(bowlers.id, bowlerId)).then(r => r[0]);
  return {
    buyerEmail: bowler?.email || undefined,
    paymentCustomerId: bowler?.paymentCustomerId || undefined,
  };
}

export function buildLineItems(
  league: typeof leagues.$inferSelect,
  quantity: string
): OrderLineItem[] {
  const lineItems: OrderLineItem[] = [];
  if (league.lineageItemVariationId) {
    lineItems.push({ catalogObjectId: league.lineageItemVariationId, quantity });
  }
  if (league.prizeFundItemVariationId) {
    lineItems.push({ catalogObjectId: league.prizeFundItemVariationId, quantity });
  }
  return lineItems;
}

export async function executeCharge(
  provider: PaymentProvider,
  cardId: string,
  amount: number,
  lineItems: OrderLineItem[],
  paymentCustomerId: string | undefined,
  buyerEmail: string | undefined
): Promise<ChargeResult> {
  // Square auto-emails its receipt only when buyerEmailAddress is set.
  const buyerEmailMissing = provider.providerName === 'square' && !buyerEmail;
  if (buyerEmailMissing) {
    logger.warn('[PaymentExecution] Square charge issued without buyer email — no auto-receipt will be sent', {
      providerName: provider.providerName,
      amount,
    });
  }

  if (lineItems.length > 0) {
    try {
      const orderResult = await provider.createOrderWithPayment(
        cardId,
        amount,
        lineItems,
        false,
        paymentCustomerId,
        buyerEmail
      );
      if (!orderResult.id) {
        return { status: 'error', error: 'Order payment succeeded but no payment ID returned', providerName: provider.providerName };
      }
      return {
        status: 'success',
        paymentId: orderResult.id,
        providerRef: orderResult.providerRef,
        providerName: provider.providerName,
        receiptUrl: orderResult.receiptUrl,
        receiptNumber: orderResult.receiptNumber,
        buyerEmailMissing,
        chargedAmount: amount,
      };
    } catch (error) {
      // Surface the typed PaymentProviderError.userMessage instead
      // of the raw `error.message` so the failed-payment row's
      // `notes` ("Failed payment: …" — see payment-lifecycle.ts)
      // carries the actionable provider reason an admin can act on,
      // not "Unknown error" or a leaked SDK string. Task #605.
      const { userMessage } = buildPaymentErrorResponse(
        error,
        error instanceof Error ? error.message : 'Unknown error',
        'PAYMENT_ERROR',
      );
      return { status: 'error', error: userMessage, providerName: provider.providerName };
    }
  } else {
    try {
      const processResult = await provider.processPayment(
        cardId,
        amount,
        false,
        paymentCustomerId,
        buyerEmail,
        undefined,
      );
      if (processResult?.id) {
        return {
          status: 'success',
          paymentId: processResult.id,
          providerRef: processResult.providerRef,
          providerName: provider.providerName,
          receiptUrl: processResult.receiptUrl,
          receiptNumber: processResult.receiptNumber,
          buyerEmailMissing,
          chargedAmount: amount,
        };
      }
      return { status: 'error', error: 'Payment processing failed', providerName: provider.providerName };
    } catch (error) {
      // Mirror the createOrderWithPayment branch above so the
      // no-line-items processPayment path (autopay / scheduled
      // executions when the league has no catalog item ids) also
      // routes typed PaymentProviderError / ProviderNotConfiguredError
      // failures through the shared helper. Without this, a typed
      // provider failure on this branch would propagate out raw and
      // the caller's failed-payment row would carry the leaked
      // `error.message` (or "Unknown error") instead of the actionable
      // sanitized provider reason. Task #605.
      const { userMessage } = buildPaymentErrorResponse(
        error,
        error instanceof Error ? error.message : 'Unknown error',
        'PAYMENT_ERROR',
      );
      return { status: 'error', error: userMessage, providerName: provider.providerName };
    }
  }
}

export async function executeChargeForLocation(
  cardId: string,
  amount: number,
  lineItems: OrderLineItem[],
  locationId: number | null,
  paymentCustomerId: string | undefined,
  buyerEmail: string | undefined
): Promise<ChargeResult> {
  try {
    const provider = await getPaymentProvider(locationId);
    return executeCharge(provider, cardId, amount, lineItems, paymentCustomerId, buyerEmail);
  } catch (e) {
    if (e instanceof ProviderNotConfiguredError) {
      // Use the helper's canonical not-configured message instead of
      // interpolating the raw `e.message` (which can include the
      // location id or processor name). Task #605.
      const { userMessage } = buildPaymentErrorResponse(e, '', 'PAYMENT_ERROR');
      return { status: 'error', error: userMessage };
    }
    throw e;
  }
}

export async function executeScheduledPayment(
  scheduleRecord: PaymentSchedule,
  league: typeof leagues.$inferSelect,
  jobId: string,
  // Task #706 — combined autopay: number of accepted-link partners
  // also being charged on this cycle. The provider sees ONE charge for
  // base × (1 + extraPayeeCount); per-bowler payment rows are split
  // upstream in lifecycle. Defaults to 0 (legacy single-bowler).
  extraPayeeCount: number = 0,
): Promise<ChargeResult> {
  const { buyerEmail, paymentCustomerId } = await fetchBowlerPaymentInfo(scheduleRecord.bowlerId);

  const locationId = league?.locationId ?? null;
  let provider;
  try {
    provider = await getPaymentProvider(locationId);
  } catch (e) {
    if (e instanceof ProviderNotConfiguredError) {
      // Same canonical message as the interactive charge path —
      // the failed-payment row's `notes` should not embed internal
      // location ids. Task #605.
      const { userMessage } = buildPaymentErrorResponse(e, '', 'PAYMENT_ERROR');
      return { status: 'error', error: userMessage };
    }
    throw e;
  }

  if (!paymentCustomerId && provider.validateCardId(scheduleRecord.paymentCardId)) {
    logger.warn(`[PaymentScheduler] Card-on-file charge for ${jobId} has no customer ID — provider may reject the payment`, {
      bowlerId: scheduleRecord.bowlerId,
    });
  }

  const weeklyFee = league?.weeklyFee || 0;
  // Task #646: if the firing date matches one of the league's
  // double-pay dates (compared in league-local timezone), the regular
  // weekly autopay charge becomes 2× the league's weekly fee
  // (per spec). Fall back to doubling the schedule's stored amount only
  // when weeklyFee is unset, so the contract still degrades gracefully.
  // The line-item quantity below tracks the resulting amount/weeklyFee
  // ratio automatically, so the catalog breakdown stays correct.
  const tz = league?.timezone ?? DEFAULT_TIMEZONE;
  const firingDateLocal = toZonedTime(new Date(scheduleRecord.nextPaymentDate), tz);
  const firingDateStr = toIsoDateStr(firingDateLocal);
  const isDoublePayDate = (league?.doublePayDates ?? [])
    .some(d => d.slice(0, 10) === firingDateStr);
  const baseChargeAmount = isDoublePayDate
    ? (weeklyFee > 0 ? weeklyFee * 2 : scheduleRecord.amount * 2)
    : scheduleRecord.amount;
  const totalPayees = 1 + Math.max(0, extraPayeeCount);
  const chargeAmount = baseChargeAmount * totalPayees;

  if (isDoublePayDate) {
    logger.info(`[PaymentExecution] Double-pay week — charging 2× for ${jobId}`, {
      firingDate: firingDateStr,
      scheduleAmount: scheduleRecord.amount,
      chargeAmount,
    });
  }

  const scheduledQty = weeklyFee > 0 && chargeAmount % weeklyFee === 0
    ? String(chargeAmount / weeklyFee)
    : '1';
  const lineItems = buildLineItems(league, scheduledQty);

  const result = await executeCharge(
    provider,
    scheduleRecord.paymentCardId!,
    chargeAmount,
    lineItems,
    paymentCustomerId,
    buyerEmail
  );
  if (isDoublePayDate) {
    result.isDoublePay = true;
  }
  return result;
}

export function computePaymentSplit(
  amount: number,
  league: typeof leagues.$inferSelect
): { lineageAmount: number | undefined; prizeFundAmount: number | undefined } {
  const lineageAmount = (league?.lineageFee != null && (league?.weeklyFee ?? 0) > 0)
    ? Math.round(amount * league.lineageFee / league.weeklyFee)
    : undefined;
  const prizeFundAmount = (league?.prizeFundFee != null && (league?.weeklyFee ?? 0) > 0)
    ? Math.round(amount * league.prizeFundFee / league.weeklyFee)
    : undefined;
  return { lineageAmount, prizeFundAmount };
}

async function createPaymentRecord(
  scheduleRecord: PaymentSchedule,
  amount: number,
  status: 'paid' | 'failed',
  league: typeof leagues.$inferSelect,
  paymentId?: string,
  notes?: string,
  weekOf?: string,
  tx?: typeof db,
  providerRef?: Record<string, string>,
  providerName?: string,
  // Receipt context threaded from executeCharge; Square-only.
  receipt?: {
    receiptUrl?: string;
    receiptNumber?: string;
    buyerEmailMissing?: boolean;
  },
): Promise<void> {
  const target = tx ?? db;
  const { lineageAmount, prizeFundAmount } = computePaymentSplit(amount, league);

  await target.insert(payments).values({
    bowlerId: scheduleRecord.bowlerId,
    leagueId: scheduleRecord.leagueId,
    amount,
    lineageAmount: status === 'paid' ? lineageAmount : undefined,
    prizeFundAmount: status === 'paid' ? prizeFundAmount : undefined,
    status,
    type: providerNameToPaymentType(providerName || ''),
    weekOf: weekOf ?? scheduleRecord.nextPaymentDate,
    providerPaymentId: paymentId,
    receiptUrl: receipt?.receiptUrl,
    receiptNumber: receipt?.receiptNumber,
    receiptEmailMissing:
      status === 'paid' && providerName === 'square'
        ? receipt?.buyerEmailMissing ?? false
        : false,
    notes,
  });
}

export async function getTotalPaidInSeason(
  bowlerId: number,
  leagueId: number,
  seasonStart: Date,
  seasonEnd: Date
): Promise<number> {
  const totalPaidResult = await db
    .select({ total: sql<number>`COALESCE(SUM(${payments.amount}), 0)` })
    .from(payments)
    .where(and(
      eq(payments.bowlerId, bowlerId),
      eq(payments.leagueId, leagueId),
      eq(payments.status, 'paid'),
      gte(payments.weekOf, seasonStart.toISOString()),
      lte(payments.weekOf, seasonEnd.toISOString())
    ));
  return Number(totalPaidResult[0]?.total || 0);
}
